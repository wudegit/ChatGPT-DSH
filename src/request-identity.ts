/**
 * P2-A request identity resolution: maps request headers to an opaque
 * stable BridgeIdentity, decoupled from MCP transport session lifecycle.
 *
 * The OpenAI adapter derives the identity from `x-openai-subject` +
 * `x-openai-session` (observed on the real ChatGPT Web + Secure MCP Tunnel
 * link, NOT an MCP standard contract and not assumed to be a permanent
 * public contract). Both must be present and non-empty; the opaque key is a
 * SHA-256 of `subject \0 session`, so raw header values never appear in
 * bridge session logs or DSH session ids.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

/** Opaque stable identity backing one Bridge Session. */
export interface BridgeIdentity {
  /** Identity provider namespace, e.g. `openai`. */
  readonly provider: string
  /** Opaque provider-scoped key; never a raw header value. */
  readonly key: string
}

/** Resolves a stable identity from request headers, if one is available. */
export interface RequestIdentityResolver {
  resolve(headers: IncomingHttpHeaders): BridgeIdentity | undefined
}

function firstNonEmpty(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  const first = typeof value === 'string' ? value : value[0]
  return first === undefined || first === '' ? undefined : first
}

/** Adapter for the headers observed on the ChatGPT Web + OpenAI tunnel link. */
export function createOpenAiIdentityResolver(): RequestIdentityResolver {
  return {
    resolve(headers: IncomingHttpHeaders): BridgeIdentity | undefined {
      const subject = firstNonEmpty(headers['x-openai-subject'])
      const session = firstNonEmpty(headers['x-openai-session'])
      if (subject === undefined || session === undefined) return undefined
      const key = createHash('sha256').update(`${subject}\0${session}`).digest('hex')
      return { provider: 'openai', key }
    },
  }
}