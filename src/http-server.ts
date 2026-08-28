/**
 * ChatGPT-DSH P1-A: localhost Streamable HTTP MCP listener with minimal
 * Bearer Token auth.
 *
 * Runs an independent minimal `node:http` listener bound to localhost by
 * default (CHATGPT_DSH_HOST / CHATGPT_DSH_PORT), serves the MCP protocol at
 * `/mcp` through the official SDK `StreamableHTTPServerTransport`, and
 * requires `Authorization: Bearer <token>` (CHATGPT_DSH_TOKEN). A bare
 * `GET /health` is available without auth and returns nothing sensitive.
 *
 * This is a separate listener (not DSH's `ctx.webServer`): the harness web
 * server binds a profile-fixed port for the web UI, and an independent
 * loopback listener keeps the bridge lifecycle and port fully owned by this
 * plugin. P1-B (public network / tunnel) will layer on top of this listener.
 *
 * MCP transport sessions: the SDK's StreamableHTTPServerTransport is one
 * MCP session per instance. A new session is created ONLY for an initialize
 * request without a session id; requests with an unknown session id get 404
 * and non-initialize requests without a session id get 400 — neither creates
 * a transport. Failed initializes are torn down immediately.
 *
 * Each MCP session owns a minimal DSH execution scope (a real `Session`
 * entered through `ctx.sessions.prepare()` / `enter()` / `announce()`),
 * passed to `ctx.tools.execute()` as the agent.
 * This makes DSH-native tool policies (e.g. fs-observation-policy state
 * keyed by `agent.session`) work over the bridge while the session header
 * carries no cwd, so fs/sandbox keep the harness startup cwd as the
 * workspace — P1-A semantics unchanged.
 *
 * P2-A (Stable Bridge Session): when a request resolves a BridgeIdentity
 * (OpenAI adapter over `x-openai-subject` + `x-openai-session`, see
 * request-identity.ts), the MCP session acquires a stable BridgeSession
 * instead of creating its own temporary scope. MCP DELETE releases the
 * lease without disposing the stable DSH scope, so consecutive tool calls
 * of one ChatGPT Conversation (each with a fresh MCP session) keep the same
 * DSH session and observation state. Requests without an identity keep the
 * P1-A temporary-scope fallback. Workspace binding (SessionHeader.cwd) is
 * explicitly NOT part of P2-A.
 *
 * @module
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createToolsServer, type BridgeToolRuntime } from './tools-bridge.ts'
import { classifyHeaders, formatDiagnosticLine, isDiagnosticsEnabled } from './diagnostics.ts'
import {
  createBridgeSessionStore,
  parseBridgeSessionIdleMs,
  parseMcpSessionIdleMs,
  type BridgeSession,
  type BridgeSessionStore,
} from './bridge-session.ts'
import {
  createOpenAiIdentityResolver,
  type BridgeIdentity,
  type RequestIdentityResolver,
} from './request-identity.ts'

/** Default bind host; the bridge only serves localhost until P1-B. */
export const DEFAULT_HOST = '127.0.0.1'

/** Default listen port for the MCP endpoint. */
export const DEFAULT_PORT = 3210

/** The MCP endpoint path. */
export const MCP_PATH = '/mcp'

/** The unauthenticated health endpoint. */
export const HEALTH_PATH = '/health'

/**
 * Minimal DSH execution scope for one MCP session: a real DSH `Session`
 * explicitly owned by the scope lifecycle (prepare → enter → announce),
 * wrapped in the minimal agent shape `ctx.tools.execute()` and the tool
 * policies read (`{ id, session }`).
 */
export interface ExecutionScope {
  /** The agent passed to `ctx.tools.execute()`. */
  readonly agent: { readonly id: string; readonly session: object }
  /** Release the scope; the owning MCP session disposes its DSH session here. */
  readonly dispose?: () => void | Promise<void>
  /** Diagnostics-only local identifier (P2-0 probe); never used for routing. */
  readonly diagnosticId?: string
}

/** Options for {@link startHttpMcpServer}. */
export interface HttpMcpServerOptions {
  /** The harness tool runtime (`ctx.tools`). */
  readonly tools: BridgeToolRuntime
  /** Tool names exposed over MCP. */
  readonly allow?: readonly string[]
  /**
   * Creates the DSH execution scope for each new MCP session. When omitted,
   * calls run without an agent (P0 behavior: observation state is not
   * recorded and `edit` stays gated by fs-observation-policy).
   */
  readonly createExecutionScope?: () => ExecutionScope
  /** Bind host (defaults to `CHATGPT_DSH_HOST` or `127.0.0.1`). */
  readonly host?: string
  /** Listen port (defaults to `CHATGPT_DSH_PORT` or 3210). */
  readonly port?: number
  /** Bearer token; required (defaults to `CHATGPT_DSH_TOKEN`). */
  readonly token?: string
  /** Log callback (defaults to console.log, matching the harness web app). */
  readonly log?: (message: string) => void
  /**
   * P2-0 request-identity diagnostics toggle; when omitted falls back to
   * `CHATGPT_DSH_DIAGNOSTIC_REQUESTS`. Default off. Logging only — never
   * changes MCP / DSH session semantics.
   */
  readonly diagnosticRequests?: boolean
  /**
   * Resolves a stable BridgeIdentity from request headers (P2-A). Defaults
   * to the OpenAI adapter (`x-openai-subject` + `x-openai-session`).
   * Requests without an identity keep the P1-A temporary-scope fallback.
   */
  readonly requestIdentityResolver?: RequestIdentityResolver
  /**
   * Bridge session idle timeout in ms. Defaults to
   * `CHATGPT_DSH_BRIDGE_SESSION_IDLE_MS` or 3600000. Invalid values fall
   * back to the default and never break startup.
   */
  readonly bridgeSessionIdleMs?: number
  /** Bridge session cleanup sweep interval in ms (defaults to min(idleMs/2, 5min)). */
  readonly bridgeSessionCleanupIntervalMs?: number
  /**
   * MCP transport session idle timeout in ms. Defaults to
   * `CHATGPT_DSH_MCP_SESSION_IDLE_MS` or 300000. Stale MCP sessions are
   * closed (releasing bridge leases / disposing fallback scopes) even when
   * the client never sends DELETE. Invalid values fall back to the default.
   */
  readonly mcpSessionIdleMs?: number
  /** Stale MCP session sweep interval in ms (defaults to min(idleMs/2, 60s)). */
  readonly mcpSessionCleanupIntervalMs?: number
}

/** The running HTTP MCP server handle. */
export interface HttpMcpServer {
  /** The full endpoint URL, e.g. `http://127.0.0.1:3210/mcp`. */
  readonly url: string
  /** The bound port (the OS-assigned value when port 0 was requested). */
  readonly port: number
  /** Stop all MCP sessions and the listener; resolves when released. */
  readonly close: () => Promise<void>
}

/** One live MCP client session: SDK transport + protocol core + DSH scope. */
interface McpSession {
  /** The SDK transport for this session (one transport = one session). */
  readonly transport: StreamableHTTPServerTransport
  /** The DSH execution scope backing this session, when one was configured. */
  readonly executionScope: ExecutionScope | undefined
  /** The stable bridge session backing this session, when identity-based. */
  readonly bridgeSession: BridgeSession | undefined
  /** Whether this MCP session created (vs reused) its bridge session. */
  readonly bridgeSessionCreated: boolean
  /** Last routed /mcp request timestamp (ms); stale sweep input. */
  lastUsedAt: number
  /** Whether the client's initialize completed (session id registered). */
  registered: boolean
  /** Close transport, protocol core, and release scope ownership. Idempotent. */
  readonly close: () => Promise<void>
}

/** Compare a presented bearer token against the configured one in constant time. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/** Respond with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read the request body as one JSON value; `undefined` when empty or not JSON. */
async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** The MCP method of a parsed JSON body; `null` when the body is not a JSON object. */
function extractMethod(body: unknown): string | null {
  if (typeof body === 'object' && body !== null) {
    const method = (body as { method?: unknown }).method
    if (typeof method === 'string') return method
  }
  return null
}

/** Whether the parsed JSON body is an MCP `initialize` request. */
function isInitialize(body: unknown): boolean {
  return extractMethod(body) === 'initialize'
}

/**
 * Start the localhost Streamable HTTP MCP server.
 *
 * Fails (throws) instead of starting without authentication when
 * `CHATGPT_DSH_TOKEN` is not configured.
 *
 * @param options - tools runtime, allowlist, and optional env overrides.
 * @returns the endpoint URL, bound port, and a close disposer.
 */
export async function startHttpMcpServer(
  options: HttpMcpServerOptions,
): Promise<HttpMcpServer> {
  const host = options.host ?? process.env.CHATGPT_DSH_HOST ?? DEFAULT_HOST
  const port = Number(options.port ?? process.env.CHATGPT_DSH_PORT ?? DEFAULT_PORT)
  const token = options.token ?? process.env.CHATGPT_DSH_TOKEN
  if (token === undefined || token === '') {
    throw new Error('CHATGPT_DSH_TOKEN is required')
  }
  const log = options.log ?? ((message: string): void => console.log(message))
  const diagnostics = options.diagnosticRequests ?? isDiagnosticsEnabled()

  // Diagnostics-only: one row per request / lifecycle event, prefixed for
  // grep. Sensitive headers are redacted inside the diagnostics module.
  let sequence = 0
  const emitDiag = (fields: Record<string, unknown>): void => {
    if (!diagnostics) return
    log(formatDiagnosticLine({ timestamp: new Date().toISOString(), ...fields }))
  }
  const disposeScope = async (scope: ExecutionScope | undefined): Promise<void> => {
    if (scope === undefined) return
    emitDiag({ event: 'EXECUTION_SCOPE_DISPOSE', exec: scope.diagnosticId ?? null })
    await scope.dispose?.()
  }

  // MCP transport session id → session pair. One SDK transport per session.
  const sessions = new Map<string, McpSession>()

  // P2-A: stable bridge sessions keyed by resolved request identity. The
  // store exists only when an execution scope factory is configured; without
  // one, every request keeps the P0 agentless behavior.
  const identityResolver = options.requestIdentityResolver ?? createOpenAiIdentityResolver()
  const bridgeIdleMs = options.bridgeSessionIdleMs
    ?? parseBridgeSessionIdleMs(process.env.CHATGPT_DSH_BRIDGE_SESSION_IDLE_MS)
  const mcpIdleMs = options.mcpSessionIdleMs
    ?? parseMcpSessionIdleMs(process.env.CHATGPT_DSH_MCP_SESSION_IDLE_MS)
  const createScope = options.createExecutionScope
  const bridgeStore: BridgeSessionStore | undefined = createScope !== undefined
    ? createBridgeSessionStore({
        createScope,
        idleMs: bridgeIdleMs,
        cleanupIntervalMs: options.bridgeSessionCleanupIntervalMs
          ?? Math.min(Math.floor(bridgeIdleMs / 2), 300_000),
        log,
      })
    : undefined

  async function createSession(identity: BridgeIdentity | undefined): Promise<McpSession> {
    let executionScope: ExecutionScope | undefined
    let bridgeSession: BridgeSession | undefined
    let bridgeSessionCreated = false
    if (identity !== undefined && bridgeStore !== undefined) {
      // Stable path: the bridge store owns the scope; this MCP session only
      // holds a lease. MCP DELETE must NOT dispose it.
      const acquired = await bridgeStore.acquire(identity)
      bridgeSession = acquired.session
      bridgeSessionCreated = acquired.created
      executionScope = acquired.session.executionScope
    } else {
      // Generic fallback: this MCP session owns a temporary scope (P1-A).
      executionScope = options.createExecutionScope?.()
      if (executionScope !== undefined) {
        emitDiag({ event: 'EXECUTION_SCOPE_CREATE', exec: executionScope.diagnosticId ?? null })
      }
    }
    const core = createToolsServer(options.tools, {
      ...options.allow === undefined ? {} : { allow: options.allow },
      ...executionScope === undefined ? {} : { agent: executionScope.agent },
    })
    let session: McpSession
    let closePromise: Promise<void> | undefined
    // Release scope ownership on close: bridge → release lease; fallback →
    // dispose own scope. Never dispose a stable scope from an MCP session.
    const releaseOwnership = (): void | Promise<void> => {
      if (bridgeSession !== undefined && bridgeStore !== undefined) {
        bridgeStore.release(bridgeSession)
        return
      }
      return disposeScope(executionScope)
    }
    const closeOnce = (): Promise<void> => {
      closePromise ??= (async () => {
        try {
          await releaseOwnership()
        } finally {
          try {
            await transport.close()
          } catch {
            // Already closed.
          }
          await core.dispose()
        }
      })()
      return closePromise
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // The session id exists only after the client's initialize succeeds;
      // register it then so later requests with Mcp-Session-Id find it.
      onsessioninitialized: (sessionId) => {
        session.registered = true
        sessions.set(sessionId, session)
        emitDiag({ event: 'MCP_SESSION_INITIALIZED', mcpSessionId: sessionId, exec: executionScope?.diagnosticId ?? null })
      },
      // SDK calls this when the client DELETE-terminates the session.
      onsessionclosed: (sessionId) => {
        emitDiag({ event: 'MCP_SESSION_DELETE', mcpSessionId: sessionId, exec: executionScope?.diagnosticId ?? null })
        void closeSession(sessionId)
      },
    })
    session = {
      transport,
      executionScope,
      bridgeSession,
      bridgeSessionCreated,
      lastUsedAt: Date.now(),
      registered: false,
      close: closeOnce,
    }
    emitDiag({
      event: 'MCP_SESSION_CREATE',
      mcpSessionId: null,
      exec: executionScope?.diagnosticId ?? null,
      ...bridgeSession === undefined ? {} : {
        bridgeSession: bridgeSession.diagnosticId,
        bridgeSessionCreated,
      },
    })
    // The SDK's onclose getter includes `| undefined` while the Transport
    // interface omits it (exactOptionalPropertyTypes mismatch); the cast
    // records only that widening. Same pattern as DSH's own mcp-client.
    try {
      await core.server.connect(transport as unknown as Transport)
    } catch (error) {
      // The scope (or lease) was acquired but the protocol server failed to
      // attach; the session is not registered, so release the lease / scope
      // and the core here rather than leaking them.
      await releaseOwnership()
      await core.dispose()
      throw error
    }
    return session
  }

  async function closeSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId)
    if (session === undefined) return
    sessions.delete(sessionId)
    emitDiag({ event: 'MCP_SESSION_CLOSE', mcpSessionId: sessionId, exec: session.executionScope?.diagnosticId ?? null })
    await session.close()
  }

  // Stale MCP session sweep: ChatGPT does not reliably send MCP DELETE, so
  // sessions idle past mcpIdleMs are closed here (releasing bridge leases or
  // disposing fallback scopes through the same ownership path as DELETE).
  // `closeSession` removes the Map entry synchronously, so a request racing
  // with the sweep simply sees an unknown session (404). close() is
  // idempotent, so DELETE / sweep / shutdown never double-close.
  let mcpCleanupTimer: ReturnType<typeof setInterval> | undefined
  mcpCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - mcpIdleMs
    for (const [sessionId, session] of [...sessions.entries()]) {
      if (session.lastUsedAt <= cutoff) {
        void closeSession(sessionId)
      }
    }
  }, options.mcpSessionCleanupIntervalMs ?? Math.min(Math.floor(mcpIdleMs / 2), 60_000))
  mcpCleanupTimer.unref()

  /**
   * Route one authenticated request to its MCP session.
   *
   * - has session id + session exists → reuse
   * - has session id + unknown → 404 (never create)
   * - no session id + POST initialize → create session
   * - no session id + anything else → 400 (never create)
   */
  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const header = req.headers['mcp-session-id']
    const sessionId = typeof header === 'string' && header !== '' ? header : undefined

    // Diagnostics-only work runs only when enabled; the default-off path
    // must not classify headers, build request fields, or bump the seq.
    const diag = diagnostics
      ? {
          base: {
            event: 'request',
            seq: ++sequence,
            method: req.method,
            path: pathname,
            hasMcpSessionId: sessionId !== undefined,
            mcpSessionId: sessionId ?? null,
          },
          headers: classifyHeaders(req.headers),
        }
      : null

    if (sessionId !== undefined) {
      const session = sessions.get(sessionId)
      if (session === undefined) {
        if (diag !== null) {
          emitDiag({
            ...diag.base,
            mcpMethod: null,
            isInitialize: false,
            createdSession: false,
            matchedSession: false,
            exec: null,
            ...diag.headers,
          })
        }
        sendJson(res, 404, { error: 'unknown session' })
        return
      }
      // Every routed request refreshes the MCP session's lastUsedAt and the
      // backing bridge session's timestamp so neither is idle-reclaimed.
      session.lastUsedAt = Date.now()
      if (bridgeStore !== undefined && session.bridgeSession !== undefined) {
        bridgeStore.touch(session.bridgeSession)
      }
      // The request body is owned by StreamableHTTPServerTransport here, so
      // the MCP method is not read out — diagnostics must not consume the
      // body stream of an established session.
      if (diag !== null) {
        emitDiag({
          ...diag.base,
          mcpMethod: null,
          isInitialize: false,
          createdSession: false,
          matchedSession: true,
          exec: session.executionScope?.diagnosticId ?? null,
          bridgeSession: session.bridgeSession?.diagnosticId ?? null,
          ...diag.headers,
        })
        if (req.method !== 'DELETE') {
          emitDiag({ event: 'MCP_SESSION_REUSE', mcpSessionId: sessionId, exec: session.executionScope?.diagnosticId ?? null })
        }
      }
      try {
        await session.transport.handleRequest(req, res)
      } catch (error) {
        log(`[chatgpt-dsh] mcp transport error: ${String(error)}`)
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'mcp transport error' })
        }
      }
      return
    }

    if (req.method !== 'POST') {
      if (diag !== null) {
        emitDiag({
          ...diag.base,
          mcpMethod: null,
          isInitialize: false,
          createdSession: false,
          matchedSession: false,
          exec: null,
          ...diag.headers,
        })
      }
      sendJson(res, 400, { error: 'missing session' })
      return
    }
    const body = await readJsonBody(req)
    if (!isInitialize(body)) {
      if (diag !== null) {
        emitDiag({
          ...diag.base,
          mcpMethod: extractMethod(body),
          isInitialize: false,
          createdSession: false,
          matchedSession: false,
          exec: null,
          ...diag.headers,
        })
      }
      sendJson(res, 400, { error: 'missing session' })
      return
    }

    // Legitimate session creation: initialize without a session id.
    const identity = identityResolver.resolve(req.headers)
    let session: McpSession
    try {
      session = await createSession(identity)
    } catch (error) {
      // ExecutionScope creation (e.g. DSH announce failure) or protocol
      // attach failed; report without taking the listener down.
      log(`[chatgpt-dsh] session creation failed: ${String(error)}`)
      if (diag !== null) {
        emitDiag({
          ...diag.base,
          mcpMethod: 'initialize',
          isInitialize: true,
          createdSession: false,
          matchedSession: false,
          exec: null,
          bridgeIdentityResolved: identity !== undefined,
          bridgeSession: null,
          bridgeSessionCreated: false,
          ...diag.headers,
        })
      }
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'mcp transport error' })
      }
      return
    }
    if (diag !== null) {
      emitDiag({
        ...diag.base,
        mcpMethod: 'initialize',
        isInitialize: true,
        createdSession: true,
        matchedSession: false,
        exec: session.executionScope?.diagnosticId ?? null,
        bridgeIdentityResolved: identity !== undefined,
        bridgeSession: session.bridgeSession?.diagnosticId ?? null,
        bridgeSessionCreated: session.bridgeSessionCreated,
        ...diag.headers,
      })
    }
    try {
      await session.transport.handleRequest(req, res, body)
    } catch (error) {
      log(`[chatgpt-dsh] mcp transport error: ${String(error)}`)
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'mcp transport error' })
      }
    } finally {
      // If initialize did not complete, the session was never registered;
      // tear the transport, core, and execution scope down so nothing leaks.
      if (!session.registered) await session.close()
    }
  }

  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'GET' && pathname === HEALTH_PATH) {
      sendJson(res, 200, { status: 'ok' })
      return
    }

    if (pathname !== MCP_PATH) {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    const authorization = req.headers.authorization
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
    if (presented === undefined || !tokenMatches(presented, token)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
        'Content-Length': Buffer.byteLength(JSON.stringify({ error: 'unauthorized' })),
      })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    await handleMcpRequest(req, res, pathname)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  // Startup failures (e.g. EADDRINUSE) rejected the promise above. From here
  // on keep a plain runtime error listener so a later server error is logged
  // instead of becoming an unhandled 'error' event. No process exit, no
  // recovery machinery.
  server.removeAllListeners('error')
  server.on('error', (error) => {
    log(`[chatgpt-dsh] http server error: ${String(error)}`)
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  const url = `http://${host}:${boundPort}${MCP_PATH}`
  log(`HTTP MCP Server listening on ${url}`)

  return {
    url,
    port: boundPort,
    async close() {
      // Stop both cleanup timers first so no sweep races the teardown.
      if (mcpCleanupTimer !== undefined) {
        clearInterval(mcpCleanupTimer)
        mcpCleanupTimer = undefined
      }
      bridgeStore?.stopCleanup()
      for (const [sessionId, session] of [...sessions.entries()]) {
        emitDiag({ event: 'MCP_SESSION_CLOSE', mcpSessionId: sessionId, exec: session.executionScope?.diagnosticId ?? null })
        await session.close()
      }
      sessions.clear()
      // Shutdown: dispose every stable bridge session exactly once (no DSH
      // session leak, no double detach).
      await bridgeStore?.disposeAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}