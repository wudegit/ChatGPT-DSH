/**
 * ChatGPT-DSH MCP Server Core — DSH Tool Adapter + MCP protocol handlers.
 *
 * Exposes a validated ChatGPT-facing profile over `ctx.tools.schemas()` as
 * MCP tools and forwards `tools/call` to `ctx.tools.execute()`. The harness
 * tool registry is the schema/execution source of truth; this module is only
 * an adapter. No tool implementation is redefined here.
 *
 * This module is transport-agnostic: it creates the MCP `Server` and the
 * tools/list + tools/call handlers, and the caller connects whichever
 * transport it wants (stdio in P0, Streamable HTTP since P1-A).
 *
 * @module
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ProfiledToolSchema } from './tool-profile.ts'

/** Bridge version, reported as the MCP server version. Keep in sync with package.json. */
export const BRIDGE_VERSION = '0.1.0'

/** Minimal structural view of one DSH tool schema (from `ctx.tools.schemas()`). */
export interface BridgeToolSchema {
  readonly name: string
  readonly description: string
  /** Standard JSON Schema object (`type: 'object'` + `properties` + `required`). */
  readonly parameters: Record<string, unknown>
}

/** Minimal structural view of the DSH `Agent` as `ctx.tools.execute()` consumes it. */
export interface BridgeAgent {
  readonly id: string
  readonly session: object
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
    /** Optional agent scope; carries the DSH session used by tool policies. */
    readonly agent?: BridgeAgent
  }): Promise<BridgeExecutionResult>
}

/** Options for the MCP server core. */
export interface ToolsServerOptions {
  /** Startup-validated DSH schemas plus ChatGPT-facing profile metadata. */
  readonly profile: readonly ProfiledToolSchema<BridgeToolSchema>[]
  /**
   * The agent scope for every call handled by this server instance (the DSH
   * execution scope of the owning MCP session). Omitted = agentless calls
   * (P0 behavior; fs-observation-policy state is not recorded).
   */
  readonly agent?: BridgeAgent
}

/** The created MCP server core plus its disposer. */
export interface ToolsServer {
  /** The MCP protocol server; the caller connects a transport. */
  readonly server: Server
  /** Close the protocol server (independent of any transport). */
  readonly dispose: () => Promise<void>
}

/** MCP tool definition projected from a DSH schema plus profile metadata. */
type McpTool = ListToolsResult['tools'][number]

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
 * Create the MCP server core over the harness tool runtime.
 *
 * @param tools - the harness tool runtime (`ctx.tools`).
 * @param options - validated exposure profile and optional execution agent.
 * @returns the protocol server (transport not yet connected) and its disposer.
 */
export function createToolsServer(
  tools: BridgeToolRuntime,
  options: ToolsServerOptions,
): ToolsServer {
  const exposedNames = new Set(options.profile.map(entry => entry.schema.name))

  const server = new Server(
    { name: 'chatgpt-dsh-mcp-bridge', version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    const toolsList: McpTool[] = options.profile.map(({ schema, annotations }) => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.parameters as unknown as McpTool['inputSchema'],
      annotations,
    }))
    return { tools: toolsList }
  })

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params
      if (!exposedNames.has(name)) {
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
          ...options.agent === undefined ? {} : { agent: options.agent },
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

  return {
    server,
    async dispose() {
      try {
        await server.close()
      } catch {
        // Already closed.
      }
    },
  }
}
