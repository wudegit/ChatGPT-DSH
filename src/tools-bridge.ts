/**
 * P0: minimal MCP Tool Bridge over the DeepSeek Harness tool registry.
 *
 * Exposes an allowlisted subset of `ctx.tools.schemas()` as MCP tools over a
 * stdio transport, and forwards `tools/call` to `ctx.tools.execute()`.
 * The harness tool registry is the source of truth; this module is only an
 * adapter. No tool implementation is redefined here.
 *
 * @module
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/** Minimal structural view of one DSH tool schema (from `ctx.tools.schemas()`). */
export interface BridgeToolSchema {
  readonly name: string
  readonly description: string
  /** Standard JSON Schema object (`type: 'object'` + `properties` + `required`). */
  readonly parameters: Record<string, unknown>
}

/** Minimal structural view of a DSH tool content block. */
export interface BridgeContentBlock {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

/** Minimal structural view of the DSH `ToolExecutionResult` union. */
export type BridgeExecutionResult =
  | {
    readonly isError: false
    readonly value?: unknown
    readonly content: readonly BridgeContentBlock[]
  }
  | {
    readonly isError: true
    readonly error: { readonly message: string; readonly info?: { readonly code?: string } }
    readonly content: readonly BridgeContentBlock[]
  }

/**
 * Minimal structural view of the DSH `ToolRuntime` (`ctx.tools`) that this
 * bridge consumes. Deliberately not imported from `@deepseek-ai/dsh-tools`:
 * the npm-published dsh packages lag the local harness checkout, and the
 * runtime shape is all the bridge needs.
 */
export interface BridgeToolRuntime {
  schemas(): BridgeToolSchema[]
  execute(input: {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly signal: AbortSignal
  }): Promise<BridgeExecutionResult>
}

/** Bridge options. */
export interface ToolsBridgeOptions {
  /** Tool names exposed over MCP; the default allowlist is empty (expose nothing). */
  readonly allow?: readonly string[]
  /** Invoked when the stdio transport closes (client disconnected or stdin EOF). */
  readonly onClose?: () => void
}

/** MCP tool definition projected from a DSH tool schema. */
type McpTool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: {
    readonly type: 'object'
    readonly properties?: Record<string, object>
    readonly required?: string[]
    readonly [key: string]: unknown
  }
}

/** Render one DSH content block as MCP text content; non-text blocks degrade to JSON. */
function blockToText(block: BridgeContentBlock): string {
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  return JSON.stringify(block)
}

/** Serialize the canonical execution value as text when content is empty. */
function valueToText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Route the harness logger output away from stdout so the MCP frame stays clean.
 *
 * P0 STDIO-ONLY workaround: MCP stdio transport 要求 stdout 只承载协议帧，
 * 而 DSH logger 默认写 stdout；把 console.log/info/warn/debug 重定向到 stderr
 * 是 stdio 协议保护措施。P1 切换 Streamable HTTP Transport 后应删除，
 * 不要把它发展成长期 Logging Infrastructure。
 */
function redirectConsoleToStderr(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
  }
  const writeStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(String).join(' ') + '\n')
  }
  console.log = writeStderr
  console.info = writeStderr
  console.warn = writeStderr
  console.debug = writeStderr
  return () => {
    console.log = original.log
    console.info = original.info
    console.warn = original.warn
    console.debug = original.debug
  }
}

/**
 * Start the MCP bridge: create the server, register handlers, connect the
 * stdio transport, and keep stdout reserved for the MCP protocol.
 *
 * @param tools - the harness tool runtime (`ctx.tools`).
 * @param options - allowlist and lifecycle hooks.
 * @returns a disposer that closes the server and transport and restores stdout.
 */
export async function startToolsBridge(
  tools: BridgeToolRuntime,
  options: ToolsBridgeOptions = {},
): Promise<() => Promise<void>> {
  const allow = new Set(options.allow ?? [])
  const restoreConsole = redirectConsoleToStderr()

  const server = new Server(
    { name: 'chatgpt-dsh-mcp-bridge', version: '0.0.1' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    const toolsList: McpTool[] = tools
      .schemas()
      .filter(schema => allow.has(schema.name))
      .map(schema => ({
        name: schema.name,
        description: schema.description,
        inputSchema: schema.parameters as unknown as McpTool['inputSchema'],
      }))
    return { tools: toolsList }
  })

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params
      if (!allow.has(name)) {
        return {
          content: [{ type: 'text', text: `tool "${name}" is not exposed by this bridge` }],
          isError: true,
        }
      }
      const controller = new AbortController()
      try {
        const result = await tools.execute({
          callId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          name,
          arguments: args ?? {},
          signal: controller.signal,
        })
        if (result.isError) {
          return {
            content: [{ type: 'text', text: result.error.message }],
            isError: true,
          }
        }
        const blocks = result.content.length > 0
          ? result.content.map(blockToText)
          : [valueToText(result.value)]
        return {
          content: blocks.map(text => ({ type: 'text', text })),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `tool "${name}" failed: ${message}` }],
          isError: true,
        }
      } finally {
        controller.abort()
      }
    },
  )

  const transport = new StdioServerTransport()
  transport.onclose = () => options.onClose?.()
  await server.connect(transport)

  return async () => {
    transport.onclose = () => {}
    try {
      await server.close()
    } catch {
      // Already closed.
    }
    try {
      await transport.close()
    } catch {
      // Already closed.
    }
    restoreConsole()
  }
}