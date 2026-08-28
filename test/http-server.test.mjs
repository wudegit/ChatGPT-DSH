/**
 * P1-A HTTP layer tests: MCP session routing, auth, lifecycle, and DSH
 * execution-scope ownership.
 *
 * Runs against `startHttpMcpServer` with a mocked BridgeToolRuntime and a
 * fake DSH session store — no DSH runtime needed. Real DSH integration is
 * covered by the manual inspection flow (see README).
 *
 * Run: npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttpMcpServer } from '../src/http-server.ts'
import { createSessionExecutionScope } from '../src/execution-scope.ts'

const TOKEN = 'test-secret'

/** Mock harness tool runtime; records calls for assertions. */
function mockTools() {
  const executeCalls = []
  return {
    tools: {
      schemas() {
        return [{
          name: 'read',
          description: 'read a file',
          parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
        }]
      },
      async execute(input) {
        executeCalls.push(input)
        return { isError: false, value: 'ok', content: [{ type: 'text', text: `ok:${input.name}` }] }
      },
    },
    executeCalls,
  }
}

/** Fake DSH session store with the lifecycle primitives the scope uses. */
function fakeSessions() {
  const live = new Map()
  const history = { prepared: [], entered: [], announced: [], detached: [] }
  return {
    live,
    history,
    service: {
      prepare(id) {
        history.prepared.push(id)
        return { id }
      },
      enter(session) {
        live.set(session.id, session)
        history.entered.push(session.id)
        return () => {
          if (live.has(session.id)) {
            live.delete(session.id)
            history.detached.push(session.id)
          }
        }
      },
      announce(session) {
        history.announced.push(session.id)
      },
    },
  }
}

/** Minimal JSON-RPC POST helper over fetch. */
async function rpc(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const ct = res.headers.get('content-type')
  let json
  if (typeof ct === 'string' && ct.startsWith('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
    json = data === '' ? undefined : JSON.parse(data)
  } else {
    try { json = JSON.parse(text) } catch { /* non-JSON body */ }
  }
  return { status: res.status, headers: res.headers, json, text }
}

const initialize = (id = 1) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
})
const toolsList = (id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/list' })

test('CHATGPT_DSH_TOKEN is required', async () => {
  await assert.rejects(
    startHttpMcpServer({ tools: mockTools().tools, token: '', port: 0 }),
    /CHATGPT_DSH_TOKEN is required/,
  )
})

test('execution scope lifecycle: prepare → enter → announce, dispose detaches once', async (t) => {
  const fake = fakeSessions()
  const scope = createSessionExecutionScope(fake.service)
  assert.equal(fake.history.prepared.length, 1)
  assert.equal(fake.history.entered.length, 1)
  assert.equal(fake.history.announced.length, 1)
  const id = scope.agent.id
  assert.ok(fake.live.has(id), 'DSH session is live after announce')

  scope.dispose()
  assert.ok(!fake.live.has(id), 'DSH session removed from store after dispose')
  assert.deepEqual(fake.history.detached, [id])
  scope.dispose()
  scope.dispose()
  assert.equal(fake.history.detached.length, 1, 'detach is single-shot')
})

test('announce failure rolls the enter back', async (t) => {
  const fake = fakeSessions()
  fake.service.announce = () => { throw new Error('listener vetoed') }
  assert.throws(() => createSessionExecutionScope(fake.service), /listener vetoed/)
  assert.equal(fake.live.size, 0, 'session rolled back after announce failure')
  assert.equal(fake.history.detached.length, 1, 'detach ran on rollback')
})

test('HTTP MCP session routing and auth', async (t) => {
  const { tools, executeCalls } = mockTools()
  const fake = fakeSessions()
  const server = await startHttpMcpServer({
    tools,
    token: TOKEN,
    port: 0,
    allow: ['read'],
    createExecutionScope: () => createSessionExecutionScope(fake.service),
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  // health: no auth required
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })

  // no auth
  assert.equal((await rpc(`${base}/mcp`, initialize())).status, 401)
  // wrong auth
  assert.equal((await rpc(`${base}/mcp`, initialize(), { Authorization: 'Bearer wrong' })).status, 401)

  const auth = { Authorization: `Bearer ${TOKEN}` }

  // non-initialize without session id → 400, no session created
  assert.equal((await rpc(`${base}/mcp`, toolsList(), auth)).status, 400)
  assert.equal(fake.live.size, 0, 'no DSH session created for rejected requests')
  // unknown session id → 404, no session created
  assert.equal((await rpc(`${base}/mcp`, toolsList(), { ...auth, 'Mcp-Session-Id': 'no-such' })).status, 404)
  assert.equal(fake.live.size, 0, 'no DSH session created for unknown session id')

  // initialize without session id → 200 + session id, session registered
  const init = await rpc(`${base}/mcp`, initialize(), auth)
  assert.equal(init.status, 200)
  const sessionId = init.headers.get('mcp-session-id')
  assert.ok(sessionId, 'initialize returns Mcp-Session-Id')
  assert.equal(init.json?.result?.serverInfo?.name, 'chatgpt-dsh-mcp-bridge')
  assert.equal(fake.live.size, 1, 'one DSH session live after initialize')

  // valid session reuse: tools/list with the session id
  const list = await rpc(`${base}/mcp`, toolsList(), { ...auth, 'Mcp-Session-Id': sessionId })
  assert.equal(list.status, 200)
  assert.deepEqual(list.json?.result?.tools?.map((x) => x.name), ['read'])
  assert.equal(executeCalls.length, 0, 'tools/list does not execute')

  // the execution scope's agent is forwarded to ctx.tools.execute()
  const call = await rpc(`${base}/mcp`, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'read', arguments: { file_path: 'README.md' } },
  }, { ...auth, 'Mcp-Session-Id': sessionId })
  assert.equal(call.status, 200)
  assert.equal(call.json?.result?.content?.[0]?.text, 'ok:read')
  assert.equal(executeCalls.length, 1)
  assert.equal(executeCalls[0].agent?.id, [...fake.live.keys()][0], 'agent scope forwarded to execute')

  // DELETE terminates the session: MCP map entry and DSH session both gone
  const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...auth, 'Mcp-Session-Id': sessionId } })
  assert.ok(del.status === 200 || del.status === 204, `DELETE accepted (${del.status})`)
  assert.equal((await rpc(`${base}/mcp`, toolsList(), { ...auth, 'Mcp-Session-Id': sessionId })).status, 404)
  assert.equal(fake.live.size, 0, 'DSH session detached after MCP DELETE')
  assert.equal(fake.history.detached.length, 1, 'detach ran once')

  // reconnect: a fresh client initialize works again with a fresh DSH session
  const init2 = await rpc(`${base}/mcp`, initialize(10), auth)
  assert.equal(init2.status, 200)
  assert.notEqual(init2.headers.get('mcp-session-id'), sessionId)
  assert.equal(fake.live.size, 1, 'reconnect creates a fresh DSH session')
  const list2 = await rpc(`${base}/mcp`, toolsList(), { ...auth, 'Mcp-Session-Id': init2.headers.get('mcp-session-id') })
  assert.equal(list2.status, 200)
})

test('failed initialize disposes the execution scope', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const server = await startHttpMcpServer({
    tools,
    token: TOKEN,
    port: 0,
    allow: ['read'],
    createExecutionScope: () => createSessionExecutionScope(fake.service),
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })
  const auth = { Authorization: `Bearer ${TOKEN}` }

  // Malformed initialize (missing required params) → 400, no session id,
  // and the DSH session created for the attempt is detached.
  const bad = await rpc(`${base}/mcp`, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26' },
  }, auth)
  assert.equal(bad.status, 400)
  assert.equal(bad.headers.get('mcp-session-id'), null, 'no session id on failed initialize')
  assert.equal(fake.live.size, 0, 'DSH session detached after failed initialize')
  assert.equal(fake.history.detached.length, 1, 'detach ran on failed initialize')

  // A subsequent valid client must initialize cleanly (no leftover transport).
  const client = new Client({ name: 'p1-test', version: '0.0.1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: auth },
  }))
  const list = await client.listTools()
  assert.deepEqual(list.tools.map((x) => x.name), ['read'])
  // Note: SDK client.close() only aborts the SSE stream — it does not send
  // DELETE (session termination is a separate SDK method). The detach paths
  // are covered by the explicit-DELETE and server-close tests above.
  await client.close()
  assert.equal(fake.live.size, 1, 'client close alone keeps the session (SDK semantics)')
})

test('server close disposes all execution scopes', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const server = await startHttpMcpServer({
    tools,
    token: TOKEN,
    port: 0,
    allow: ['read'],
    createExecutionScope: () => createSessionExecutionScope(fake.service),
  })
  const base = server.url.replace(/\/mcp$/, '')
  const auth = { Authorization: `Bearer ${TOKEN}` }

  const init = await rpc(`${base}/mcp`, initialize(), auth)
  assert.equal(init.status, 200)
  assert.equal(fake.live.size, 1, 'DSH session live before close')

  await server.close()
  assert.equal(fake.live.size, 0, 'DSH session detached on server close')
  assert.equal(fake.history.detached.length, 1)
  // close is idempotent
  await server.close()
  assert.equal(fake.history.detached.length, 1, 'no double detach on second close')
})

test('close releases the port', async (t) => {
  const { tools } = mockTools()
  const server = await startHttpMcpServer({ tools, token: TOKEN, port: 0 })
  const base = server.url.replace(/\/mcp$/, '')
  await server.close()
  await assert.rejects(fetch(`${base}/health`), /fetch failed|ECONNREFUSED/i)
})