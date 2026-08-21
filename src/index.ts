/**
 * ChatGPT-DSH MCP Bridge — DeepSeek Harness plugin entry.
 *
 * Loaded as a regular Cordis plugin inside the harness runtime (`dsh web
 * --patch cordis.patch.yml`). It reuses the running harness `ctx.tools` and
 * exposes an allowlisted subset as MCP tools over stdio.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { startToolsBridge, type BridgeToolRuntime } from './tools-bridge.ts'

/** Plugin name used by loader diagnostics. */
export const name = 'chatgpt-dsh-mcp-bridge'

/** Services required before the bridge starts. */
export const inject = ['tools']

/** P0 test allowlist: read / write / edit from the harness filesystem tools. */
const ALLOWED_TOOLS: readonly string[] = ['read', 'write', 'edit']

/** How long to wait after the transport closes before forcing process exit. */
const EXIT_GRACE_MS = 3000

export function apply(ctx: Context): void {
  const tools = (ctx as unknown as { tools: BridgeToolRuntime }).tools

  // The bridge only owns the stdio transport when the harness process was
  // spawned as an MCP server (stdin is a pipe, e.g. from MCP Inspector).
  if (process.stdin.isTTY) {
    ctx.logger.info(`${name}: stdin is a TTY, MCP bridge not started`)
    return
  }

  ctx.effect(async () => {
    let exitTimer: NodeJS.Timeout | undefined
    const stop = await startToolsBridge(tools, {
      allow: ALLOWED_TOOLS,
      onClose: () => {
        ctx.logger.info(`${name}: transport closed, exiting`)
        // P0 STDIO TEST ONLY: 当前 stdio transport 断开时强制退出宿主进程。
        // 这是 MCP Client（如 Inspector）一次性 spawn 验证的临时生命周期策略，
        // 保证连接断开后无残留 Node / DSH 进程。此逻辑只适用于 stdio 场景；
        // P1 Streamable HTTP Bridge 必须删除或替换为正常生命周期管理。
        exitTimer = setTimeout(() => process.exit(0), EXIT_GRACE_MS)
        exitTimer.unref()
      },
    })
    ctx.logger.info(`${name}: MCP bridge started (tools: ${ALLOWED_TOOLS.join(', ')})`)
    return async () => {
      if (exitTimer !== undefined) clearTimeout(exitTimer)
      await stop()
    }
  })
}