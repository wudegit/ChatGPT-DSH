/**
 * P2-A Stable Bridge Session: one stable DSH ExecutionScope per resolved
 * BridgeIdentity, decoupled from MCP transport session lifecycle.
 *
 * A BridgeSession owns its ExecutionScope (and therefore the DSH session).
 * MCP sessions only hold leases on it: MCP DELETE releases the lease instead
 * of disposing the scope, so a ChatGPT Conversation that re-initializes a
 * fresh MCP session per tool call keeps the same DSH session (observation
 * continuity). Idle sessions with no active lease are disposed after
 * `idleMs` by a low-frequency unref'd timer; `disposeAll` on shutdown
 * disposes every remaining scope exactly once (dispose is idempotent).
 *
 * @module
 */

import type { ExecutionScope } from './http-server.ts'
import type { BridgeIdentity } from './request-identity.ts'

/** Default bridge session idle timeout (1 hour). */
export const DEFAULT_BRIDGE_SESSION_IDLE_MS = 3600000

/** Default MCP transport session idle timeout (5 minutes). */
export const DEFAULT_MCP_SESSION_IDLE_MS = 300000

/**
 * Parse `CHATGPT_DSH_BRIDGE_SESSION_IDLE_MS`. Unset → `fallback`; any value
 * that is not a positive integer (0 / negative / NaN / non-integer) also
 * falls back. A bad env var must never break plugin startup.
 */
export function parseBridgeSessionIdleMs(
  value: string | undefined,
  fallback: number = DEFAULT_BRIDGE_SESSION_IDLE_MS,
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

/**
 * Parse `CHATGPT_DSH_MCP_SESSION_IDLE_MS`. Same semantics as the bridge idle
 * parser: unset → `fallback`; non-positive-integer values fall back too.
 */
export function parseMcpSessionIdleMs(
  value: string | undefined,
  fallback: number = DEFAULT_MCP_SESSION_IDLE_MS,
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

/** One stable execution scope keyed by a BridgeIdentity. */
export interface BridgeSession {
  /** The identity this session was created for. */
  readonly identity: BridgeIdentity
  /** The stable DSH execution scope owned by this bridge session. */
  readonly executionScope: ExecutionScope
  /** Diagnostics-only local id, e.g. `bridge-1`; never the identity key. */
  readonly diagnosticId: string
  /** Whether dispose has been initiated (idempotent dispose guard). */
  readonly disposed: boolean
  /** Last acquire/release/touch timestamp (ms); idle cleanup input. */
  lastUsedAt: number
  /** Active MCP session leases; > 0 blocks idle cleanup. */
  leaseCount: number
  /** Dispose the owned scope exactly once. Idempotent. */
  dispose(): Promise<void>
}

/** Options for {@link createBridgeSessionStore}. */
export interface BridgeSessionStoreOptions {
  /** Creates the DSH execution scope for a new bridge session. */
  readonly createScope: () => ExecutionScope
  /** Idle timeout in ms; sessions with zero leases older than this are disposed. */
  readonly idleMs: number
  /** Cleanup sweep interval in ms. */
  readonly cleanupIntervalMs: number
  /** Log callback (defaults to console.log). */
  readonly log?: (message: string) => void
  /** Clock for lastUsedAt / idle checks (defaults to Date.now). */
  readonly now?: () => number
  /**
   * Test-only injection: awaited inside getOrCreate after reading an
   * existing session promise and before re-validating it. Lets tests open
   * the sweep/acquire race window deterministically. Production callers
   * never pass this.
   */
  readonly beforeSessionRevalidate?: (session: BridgeSession) => Promise<void>
}

/** Result of acquiring a bridge session: whether it was just created. */
export interface AcquiredBridgeSession {
  readonly session: BridgeSession
  /** True when this acquire created the session (first ever use of the identity). */
  readonly created: boolean
}

/** The Bridge Session store: concurrent-safe identity → session mapping. */
export interface BridgeSessionStore {
  /** Acquire (create on first use) the stable session for an identity. */
  acquire(identity: BridgeIdentity): Promise<AcquiredBridgeSession>
  /** Release one lease; duplicate releases are no-ops. */
  release(session: BridgeSession): void
  /** Mark the session recently used (idle cleanup input). */
  touch(session: BridgeSession): void
  /** Dispose every remaining bridge session exactly once. */
  disposeAll(): Promise<void>
  /** Stop the cleanup timer (idempotent). */
  stopCleanup(): void
}

/** Ambiguity-free namespaced store key: identity is (provider, key), not key alone. */
function identityMapKey(identity: BridgeIdentity): string {
  return `${identity.provider}\0${identity.key}`
}

/**
 * Create the bridge session store.
 *
 * Concurrency: `getOrCreate` keys the namespaced `(provider, key)` →
 * `Promise<BridgeSession>`, so concurrent acquires for the same identity
 * share one in-flight creation and only one ExecutionScope is ever created.
 * A failed scope creation removes the pending entry so a later request can
 * retry. Different providers never collide even with identical opaque keys.
 */
export function createBridgeSessionStore(options: BridgeSessionStoreOptions): BridgeSessionStore {
  const log = options.log ?? ((message: string): void => console.log(message))
  const now = options.now ?? ((): number => Date.now())
  const sessions = new Map<string, Promise<BridgeSession>>()
  let nextDiagnosticId = 1
  let cleanupTimer: ReturnType<typeof setInterval> | undefined

  const createSession = async (identity: BridgeIdentity): Promise<BridgeSession> => {
    const scope = options.createScope()
    const diagnosticId = `bridge-${nextDiagnosticId}`
    nextDiagnosticId += 1
    let disposed = false
    let disposePromise: Promise<void> | undefined
    const session: BridgeSession = {
      identity,
      executionScope: scope,
      diagnosticId,
      get disposed() { return disposed },
      lastUsedAt: now(),
      leaseCount: 0,
      dispose: () => {
        disposePromise ??= (async () => {
          if (!disposed) {
            disposed = true
            try {
              await scope.dispose?.()
            } finally {
              log(`[chatgpt-dsh] bridge session disposed bridgeSession=${session.diagnosticId} provider=${identity.provider}`)
            }
          }
        })()
        return disposePromise
      },
    }
    return session
  }

  /**
 * getOrCreate must not hand out a session the idle sweep has already
 * evicted: after `await existing`, the entry is re-validated against the
 * current map and the session's disposed flag. If the sweep removed (or is
 * disposing) the session while we awaited it, the loop re-reads the map and
 * either picks up a newer entry or creates a fresh session. The loop always
 * terminates: each iteration ends with a valid existing entry, a fresh
 * creation, or a thrown creation error — a disposed session can never sit
 * in the map (the sweep deletes before disposing), and the defensive drop
 * below guarantees that even in an inconsistent state the next iteration
 * takes the creation branch.
 */
const getOrCreate = async (identity: BridgeIdentity): Promise<AcquiredBridgeSession> => {
    while (true) {
      const mapKey = identityMapKey(identity)
      const existing = sessions.get(mapKey)
      if (existing !== undefined) {
        const session = await existing
        await options.beforeSessionRevalidate?.(session)
        if (session.disposed) {
          // Defensive: never hand out a disposed session; drop the stale
          // entry so the next iteration creates a fresh one.
          if (sessions.get(mapKey) === existing) sessions.delete(mapKey)
          continue
        }
        if (sessions.get(mapKey) !== existing) {
          // The idle sweep evicted this entry while we awaited it.
          continue
        }
        return { session, created: false }
      }
      const pending = createSession(identity)
      sessions.set(mapKey, pending)
      try {
        const session = await pending
        log(`[chatgpt-dsh] bridge session created bridgeSession=${session.diagnosticId} provider=${identity.provider}`)
        return { session, created: true }
      } catch (error) {
        if (sessions.get(mapKey) === pending) sessions.delete(mapKey)
        throw error
      }
    }
  }

  const sweep = (): void => {
    const cutoff = now() - options.idleMs
    for (const [mapKey, pending] of [...sessions.entries()]) {
      void pending.then((session) => {
        if (session.leaseCount === 0 && !session.disposed && session.lastUsedAt <= cutoff) {
          if (sessions.get(mapKey) === pending) sessions.delete(mapKey)
          void session.dispose().catch((error) => {
            log(`[chatgpt-dsh] bridge session dispose failed bridgeSession=${session.diagnosticId}: ${String(error)}`)
          })
        }
      }).catch(() => {
        // The pending creation failed; drop the stale entry so a later
        // request can retry the identity.
        if (sessions.get(mapKey) === pending) sessions.delete(mapKey)
      })
    }
  }

  cleanupTimer = setInterval(sweep, options.cleanupIntervalMs)
  cleanupTimer.unref()

  return {
    async acquire(identity: BridgeIdentity): Promise<AcquiredBridgeSession> {
      const acquired = await getOrCreate(identity)
      acquired.session.leaseCount += 1
      acquired.session.lastUsedAt = now()
      if (!acquired.created) {
        log(`[chatgpt-dsh] bridge session reused bridgeSession=${acquired.session.diagnosticId} provider=${identity.provider}`)
      }
      return acquired
    },
    release(session: BridgeSession): void {
      if (session.disposed || session.leaseCount <= 0) return
      session.leaseCount -= 1
      session.lastUsedAt = now()
      log(`[chatgpt-dsh] bridge session released bridgeSession=${session.diagnosticId} provider=${session.identity.provider}`)
    },
    touch(session: BridgeSession): void {
      if (session.disposed) return
      session.lastUsedAt = now()
    },
    async disposeAll(): Promise<void> {
      const pending = [...sessions.values()]
      sessions.clear()
      await Promise.all(pending.map(async (entry) => {
        try {
          const session = await entry
          await session.dispose()
        } catch {
          // The session's creation failed; there is nothing to dispose.
        }
      }))
    },
    stopCleanup(): void {
      if (cleanupTimer !== undefined) {
        clearInterval(cleanupTimer)
        cleanupTimer = undefined
      }
    },
  }
}