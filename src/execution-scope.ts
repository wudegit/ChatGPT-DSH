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
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { ExecutionScope } from './http-server.ts'

/** Structural view of the harness session store lifecycle primitives. */
export interface DshSessionService {
  /** Construct a session WITHOUT entering the store. */
  prepare(id: string): { readonly id: string }
  /** Enter a prepared session into the store; returns the single-shot detach. */
  enter(session: { readonly id: string }): () => void
  /** Publish `session/created` for an entered session (may throw → detach). */
  announce(session: { readonly id: string }): void
}

/**
 * Create one ExecutionScope owning a fresh temporary DSH session.
 *
 * @param sessions - the harness session store (`ctx.sessions`).
 * @returns the scope: the minimal agent for `ctx.tools.execute()` and a
 *   single-shot dispose that detaches the DSH session from the store.
 */
export function createSessionExecutionScope(sessions: DshSessionService): ExecutionScope {
  const id = `chatgpt-dsh-bridge-${randomUUID()}`
  const session = sessions.prepare(id)
  const detach = sessions.enter(session)
  try {
    sessions.announce(session)
  } catch (error) {
    detach()
    throw error
  }
  return {
    agent: { id: session.id, session },
    dispose: () => {
      detach()
    },
  }
}