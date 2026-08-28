/**
 * P1-A minimal DSH execution scope: one temporary DSH session owned by one
 * MCP session, built with the store lifecycle primitives so it can be
 * detached exactly when the MCP session ends.
 *
 * Lifecycle: prepare → enter → announce; dispose calls the single-shot
 * `detach()` returned by enter, removing the session from the store.
 * announce failure rolls the enter back before rethrowing.
 *
 * This is execution-context plumbing (the observation/sandbox owner for
 * `ctx.tools.execute()`), NOT the P2 Bridge Session / ChatGPT conversation
 * mapping.
 *
 * P2-B first phase (Workspace Binding): an optional `cwd` is written into
 * the DSH SessionHeader through the native `prepare(id, { meta: { cwd } })`
 * API, so DSH fs / fs-search / sandbox-policy inherit the Host workspace
 * instead of falling back to `process.cwd()` at use time. The header is
 * immutable once created — no post-creation header mutation, and no second
 * cwd state kept here.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { ExecutionScope } from './http-server.ts'

/** Options for {@link createSessionExecutionScope}. */
export interface CreateSessionExecutionScopeOptions {
  /**
   * Absolute Host workspace to freeze into the DSH SessionHeader at
   * creation (P2-B). Omitted → `prepare(id)` without meta (P1-A behavior).
   */
  readonly cwd?: string
}

/** Structural view of the harness session store lifecycle primitives. */
export interface DshSessionService {
  /**
   * Construct a session WITHOUT entering the store. The minimal structural
   * view covers only what this plugin uses: the id and optional creation
   * metadata `meta.cwd` (DSH native `PrepareSessionOptions`).
   */
  prepare(id: string, options?: { readonly meta?: { readonly cwd?: string } }): { readonly id: string }
  /** Enter a prepared session into the store; returns the single-shot detach. */
  enter(session: { readonly id: string }): () => void
  /** Publish `session/created` for an entered session (may throw → detach). */
  announce(session: { readonly id: string }): void
}

/** Diagnostics-only monotonic local scope id (P2-0 probe), e.g. `exec-1`. */
let nextDiagnosticId = 1

/**
 * Create one ExecutionScope owning a fresh temporary DSH session.
 *
 * @param sessions - the harness session store (`ctx.sessions`).
 * @param options - optional workspace binding: when `cwd` is present, it is
 *   written into the SessionHeader at creation via the native
 *   `prepare(id, { meta: { cwd } })` API (must be an absolute path, enforced
 *   by DSH). When omitted, sessions are prepared without meta.
 * @returns the scope: the minimal agent for `ctx.tools.execute()` and a
 *   single-shot dispose that detaches the DSH session from the store.
 */
export function createSessionExecutionScope(
  sessions: DshSessionService,
  options?: CreateSessionExecutionScopeOptions,
): ExecutionScope {
  const id = `chatgpt-dsh-bridge-${randomUUID()}`
  const session = options?.cwd === undefined
    ? sessions.prepare(id)
    : sessions.prepare(id, { meta: { cwd: options.cwd } })
  const detach = sessions.enter(session)
  try {
    sessions.announce(session)
  } catch (error) {
    detach()
    throw error
  }
  const diagnosticId = `exec-${nextDiagnosticId}`
  nextDiagnosticId += 1
  return {
    agent: { id: session.id, session },
    diagnosticId,
    dispose: () => {
      detach()
    },
  }
}