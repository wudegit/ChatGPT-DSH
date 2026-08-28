/**
 * ChatGPT-DSH MCP Bridge — DeepSeek Harness plugin entry.
 *
 * Loaded as a regular Cordis plugin inside the harness runtime (`dsh web
 * --patch cordis.patch.yml`). It reuses the running harness `ctx.tools` and
 * exposes an allowlisted subset as MCP tools over a localhost Streamable
 * HTTP endpoint with minimal Bearer Token auth (P1-A).
 *
 * Lifecycle: the HTTP listener starts on plugin load and keeps running
 * across arbitrary MCP client connect/disconnect cycles; it closes only when
 * the plugin unloads (or the harness stops).
 *
 * Each MCP session owns an ExecutionScope, which owns one temporary DSH
 * execution session (prepare → enter → announce) used as the minimal agent
 * for `ctx.tools.execute()`. The scope's dispose detaches the DSH session
 * from the session store, so MCP DELETE / server shutdown ends the DSH
 * session too. P2-B first phase (Workspace Binding): the DSH Host cwd is
 * captured once at plugin startup and written into every ExecutionSession
 * via `prepare(id, { meta: { cwd } })`, so DSH fs / fs-search /
 * sandbox-policy inherit the Host workspace from `SessionHeader.cwd`
 * instead of falling back to `process.cwd()` at use time — one running
 * DSH Runtime → one fixed Host workspace. This is execution-context
 * plumbing, not the P2 Bridge Session mapping.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { startHttpMcpServer, type HttpMcpServerOptions } from './http-server.ts'
import { createSessionExecutionScope, type DshSessionService } from './execution-scope.ts'
import type { BridgeToolRuntime } from './tools-bridge.ts'

/** Plugin name used by loader diagnostics. */
export const name = 'chatgpt-dsh-mcp-bridge'

/** Services required before the bridge starts. */
export const inject = ['tools', 'sessions']

/** P0/P1-A test allowlist: read / write / edit from the harness filesystem tools. */
const ALLOWED_TOOLS: readonly string[] = ['read', 'write', 'edit']

export function apply(ctx: Context): void {
  const tools = (ctx as unknown as { tools: BridgeToolRuntime }).tools
  const sessions = (ctx as unknown as { sessions: DshSessionService }).sessions

  // P2-B: capture the DSH Host cwd ONCE at plugin startup. It is the fixed
  // workspace of this running DSH Runtime: every Execution Session created
  // by the factory below freezes it into SessionHeader.cwd. Deliberately
  // not re-read per Bridge Session, so a later process.cwd() change can
  // never silently split sessions across workspaces.
  const workspaceCwd = process.cwd()

  // Missing token must not take the harness down: DSH keeps running, the MCP
  // bridge simply does not start. console.error is used because the harness
  // logger level may hide [I]/[E] rows in this profile; HTTP transport means
  // stdout is not reserved for a protocol, so a console line is safe.
  const token = process.env.CHATGPT_DSH_TOKEN
  if (token === undefined || token === '') {
    const message = `${name}: CHATGPT_DSH_TOKEN is required; HTTP MCP Server not started`
    ctx.logger.error(message)
    console.error(message)
    return
  }

  ctx.effect(async () => {
    const options: HttpMcpServerOptions = {
      tools,
      allow: ALLOWED_TOOLS,
      // One temporary DSH execution session per MCP session, owned by the
      // ExecutionScope (prepare → enter → announce; dispose detaches).
      // fs-observation-policy keys its state on `agent.session`; P2-B writes
      // the Host workspace into SessionHeader.cwd via `meta.cwd` so DSH
      // fs/sandbox inherit it natively (no fallback to process.cwd()).
      createExecutionScope: () => createSessionExecutionScope(sessions, { cwd: workspaceCwd }),
    }
    const http = await startHttpMcpServer(options)
    // startHttpMcpServer logs the endpoint via console.log (like dsh-web-app's
    // URL print) so it is visible even when logger levels hide [I] rows.
    ctx.logger.info(`${name}: HTTP MCP Server listening on ${http.url}`)
    return async () => {
      await http.close()
      ctx.logger.info(`${name}: HTTP MCP Server closed`)
    }
  })
}