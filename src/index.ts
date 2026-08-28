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
 * session too. The session header carries no cwd, so fs/sandbox keep the
 * harness startup cwd as the workspace — execution-context plumbing, not
 * the P2 Bridge Session.
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
      // fs-observation-policy keys its state on `agent.session`; header.cwd
      // stays unset so fs/sandbox keep the harness startup cwd (P1-A).
      createExecutionScope: () => createSessionExecutionScope(sessions),
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