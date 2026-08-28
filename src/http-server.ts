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
 * workspace — P1-A semantics unchanged. This is execution-context plumbing,
 * NOT the P2 Bridge Session (no ChatGPT conversation mapping).
 *
 * @module
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createToolsServer, type BridgeToolRuntime } from './tools-bridge.ts'

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
  /** Whether the client's initialize completed (session id registered). */
  registered: boolean
  /** Close transport, protocol core, and scope. Idempotent. */
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

/** Whether the parsed JSON body is an MCP `initialize` request. */
function isInitialize(body: unknown): boolean {
  return typeof body === 'object' && body !== null
    && (body as { method?: unknown }).method === 'initialize'
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

  // MCP transport session id → session pair. One SDK transport per session.
  const sessions = new Map<string, McpSession>()

  async function createSession(): Promise<McpSession> {
    const executionScope = options.createExecutionScope?.()
    const core = createToolsServer(options.tools, {
      ...options.allow === undefined ? {} : { allow: options.allow },
      ...executionScope === undefined ? {} : { agent: executionScope.agent },
    })
    let session: McpSession
    let closePromise: Promise<void> | undefined
    const closeOnce = (): Promise<void> => {
      closePromise ??= (async () => {
        try {
          await executionScope?.dispose?.()
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
      },
      // SDK calls this when the client DELETE-terminates the session.
      onsessionclosed: (sessionId) => {
        void closeSession(sessionId)
      },
    })
    session = {
      transport,
      executionScope,
      registered: false,
      close: closeOnce,
    }
    // The SDK's onclose getter includes `| undefined` while the Transport
    // interface omits it (exactOptionalPropertyTypes mismatch); the cast
    // records only that widening. Same pattern as DSH's own mcp-client.
    try {
      await core.server.connect(transport as unknown as Transport)
    } catch (error) {
      // The scope was created but the protocol server failed to attach; the
      // session is not registered, so release the scope (DSH session detach)
      // and the core here rather than leaking them.
      await executionScope?.dispose?.()
      await core.dispose()
      throw error
    }
    return session
  }

  async function closeSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId)
    if (session === undefined) return
    sessions.delete(sessionId)
    await session.close()
  }

  /**
   * Route one authenticated request to its MCP session.
   *
   * - has session id + session exists → reuse
   * - has session id + unknown → 404 (never create)
   * - no session id + POST initialize → create session
   * - no session id + anything else → 400 (never create)
   */
  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers['mcp-session-id']
    const sessionId = typeof header === 'string' && header !== '' ? header : undefined

    if (sessionId !== undefined) {
      const session = sessions.get(sessionId)
      if (session === undefined) {
        sendJson(res, 404, { error: 'unknown session' })
        return
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
      sendJson(res, 400, { error: 'missing session' })
      return
    }
    const body = await readJsonBody(req)
    if (!isInitialize(body)) {
      sendJson(res, 400, { error: 'missing session' })
      return
    }

    // Legitimate session creation: initialize without a session id.
    let session: McpSession
    try {
      session = await createSession()
    } catch (error) {
      // ExecutionScope creation (e.g. DSH announce failure) or protocol
      // attach failed; report without taking the listener down.
      log(`[chatgpt-dsh] session creation failed: ${String(error)}`)
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'mcp transport error' })
      }
      return
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

    await handleMcpRequest(req, res)
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
      for (const session of [...sessions.values()]) {
        await session.close()
      }
      sessions.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}