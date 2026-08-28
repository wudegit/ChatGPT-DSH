/**
 * P2-0 request identity diagnostics: opt-in per-request / MCP session
 * lifecycle probe logs for the HTTP MCP listener.
 *
 * Purpose: observe real ChatGPT Web MCP request / session identity features
 * without changing session semantics and without leaking authentication
 * headers. Default off (`CHATGPT_DSH_DIAGNOSTIC_REQUESTS`). This is an
 * observation probe only — nothing here is used for session mapping.
 *
 * @module
 */

import type { IncomingHttpHeaders } from 'node:http'

/** Stable line prefix for every diagnostics line; grep-able. */
export const DIAGNOSTIC_LOG_PREFIX = '[chatgpt-dsh][diag]'

/** Marker that replaces the names of sensitive headers in header-name lists. */
export const REDACTED_HEADER_LABEL = '<redacted-header>'

/**
 * Header names whose values are never logged; even their names are collapsed
 * to REDACTED_HEADER_LABEL. Includes exact authentication headers plus any
 * name containing token / secret / password / credential / auth / key.
 */
const SENSITIVE_NAME_PATTERNS: readonly RegExp[] = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^proxy-authorization$/i,
  /^x-api-key$/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /auth/i,
  /key/i,
]

/**
 * Explicit allowlist of identity-candidate headers whose values may be
 * logged (observed only, never mapped to sessions). `x-openai-*` /
 * `openai-*` prefixes are allowed too, but any candidate that matches a
 * sensitive pattern is still dropped before reaching here.
 */
const IDENTITY_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'x-request-id',
  'request-id',
  'traceparent',
  'tracestate',
])

function isIdentityCandidate(lowerName: string): boolean {
  return IDENTITY_HEADER_ALLOWLIST.has(lowerName)
    || lowerName.startsWith('x-openai-')
    || lowerName.startsWith('openai-')
}

/**
 * Whether request diagnostics are enabled.
 *
 * Unset / empty / `0` / `false` → disabled; `1` / `true` (case-insensitive)
 * → enabled. Any other value stays disabled.
 */
export function isDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CHATGPT_DSH_DIAGNOSTIC_REQUESTS
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true'
}

/** Header name list + identity-candidate values after redaction. */
export interface HeaderClassification {
  /** Every request header name; sensitive names collapsed to REDACTED_HEADER_LABEL. */
  readonly headerNames: readonly string[]
  /** Allowlisted identity-candidate header values (e.g. x-request-id, traceparent). */
  readonly identity: Readonly<Record<string, string>>
}

/**
 * Classify request headers for diagnostics: a name list with sensitive names
 * collapsed, plus values only for the explicit identity-candidate allowlist.
 * Never serializes the raw `IncomingHttpHeaders` object.
 */
export function classifyHeaders(headers: IncomingHttpHeaders): HeaderClassification {
  const headerNames: string[] = []
  const identity: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(lower))) {
      headerNames.push(REDACTED_HEADER_LABEL)
      continue
    }
    headerNames.push(name)
    if (isIdentityCandidate(lower)) {
      identity[name] = typeof value === 'string' ? value : value.join(',')
    }
  }
  return { headerNames, identity }
}

/** Render one diagnostics line: stable prefix + one JSON row. */
export function formatDiagnosticLine(fields: Record<string, unknown>): string {
  return `${DIAGNOSTIC_LOG_PREFIX} ${JSON.stringify(fields)}`
}
