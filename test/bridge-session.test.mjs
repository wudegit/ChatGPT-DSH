/**
 * P2-A Stable Bridge Session tests: identity resolution, bridge session
 * reuse / isolation, generic fallback, DELETE semantics, idle cleanup,
 * concurrency, shutdown, and error paths.
 *
 * Runs against `startHttpMcpServer` with a mocked BridgeToolRuntime and a
 * fake DSH session store — no DSH runtime needed. Real DSH observation
 * continuity is covered by the manual flow (see README).
 *
 * Run: npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHttpMcpServer } from '../src/http-server.ts'
import { createSessionExecutionScope } from '../src/execution-scope.ts'
import { createOpenAiIdentityResolver } from '../src/request-identity.ts'
import {
  createBridgeSessionStore,
  DEFAULT_BRIDGE_SESSION_IDLE_MS,
  DEFAULT_MCP_SESSION_IDLE_MS,
  parseBridgeSessionIdleMs,
  parseMcpSessionIdleMs,
} from '../src/bridge-session.ts'

const TOKEN = 'test-secret'

/** Mock harness tool runtime; records calls for assertions. */
function mockTools() {
  const executeCalls = []
  return {
    tools: {
      schemas() {
        return [
          {
            name: 'read',
            description: 'read a file',
            parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
          },
          {
            name: 'write',
            description: 'write a file',
            parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
          },
          {
            name: 'edit',
            description: 'edit a file',
            parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] },
          },
          {
            name: 'glob',
            description: 'find files',
            parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
          },
          {
            name: 'grep',
            description: 'search file contents',
            parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
          },
        ]
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

/** createExecutionScope factory that counts how many scopes were created. */
function countingScopes(fake) {
  let count = 0
  return {
    count: () => count,
    create: () => {
      count += 1
      return createSessionExecutionScope(fake.service)
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

/** Auth header plus optional OpenAI identity headers. */
function authHeaders(subject, session) {
  const headers = { Authorization: `Bearer ${TOKEN}` }
  if (subject !== undefined) headers['x-openai-subject'] = subject
  if (session !== undefined) headers['x-openai-session'] = session
  return headers
}

const toolsCall = (id, name, args) => ({
  jsonrpc: '2.0', id, method: 'tools/call',
  params: { name, arguments: args },
})

/** Fast idle settings for cleanup tests. */
const FAST_IDLE = { bridgeSessionIdleMs: 30, bridgeSessionCleanupIntervalMs: 5 }

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('request identity: OpenAI adapter requires both headers', () => {
  const resolver = createOpenAiIdentityResolver()
  assert.equal(resolver.resolve({}), undefined)
  assert.equal(resolver.resolve({ 'x-openai-subject': 'U' }), undefined)
  assert.equal(resolver.resolve({ 'x-openai-session': 'C' }), undefined)
  assert.equal(resolver.resolve({ 'x-openai-subject': '', 'x-openai-session': 'C' }), undefined)
  assert.equal(resolver.resolve({ 'x-openai-subject': 'U', 'x-openai-session': '' }), undefined)

  const a = resolver.resolve({ 'x-openai-subject': 'U', 'x-openai-session': 'C1' })
  const b = resolver.resolve({ 'x-openai-subject': 'U', 'x-openai-session': 'C1' })
  assert.ok(a !== undefined && b !== undefined)
  assert.equal(a.provider, 'openai')
  assert.match(a.key, /^[0-9a-f]{64}$/, 'opaque sha256 hex key')
  assert.equal(a.key, b.key, 'stable for the same subject+session')
  assert.notEqual(
    a.key,
    resolver.resolve({ 'x-openai-subject': 'U', 'x-openai-session': 'C2' }).key,
    'different conversation → different key',
  )
  assert.notEqual(
    a.key,
    resolver.resolve({ 'x-openai-subject': 'V', 'x-openai-session': 'C1' }).key,
    'different subject → different key',
  )
})

test('bridge idle config parsing', () => {
  assert.equal(parseBridgeSessionIdleMs(undefined), DEFAULT_BRIDGE_SESSION_IDLE_MS)
  assert.equal(parseBridgeSessionIdleMs('5000'), 5000)
  assert.equal(parseBridgeSessionIdleMs('0'), DEFAULT_BRIDGE_SESSION_IDLE_MS)
  assert.equal(parseBridgeSessionIdleMs('-5'), DEFAULT_BRIDGE_SESSION_IDLE_MS)
  assert.equal(parseBridgeSessionIdleMs('abc'), DEFAULT_BRIDGE_SESSION_IDLE_MS)
  assert.equal(parseBridgeSessionIdleMs('1.5'), DEFAULT_BRIDGE_SESSION_IDLE_MS)
})

test('bridge: same identity reuses one stable scope across MCP sessions', async (t) => {
  const { tools, executeCalls } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools,
    token: TOKEN,
    port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C1')
  const initA = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(initA.status, 200)
  const sidA = initA.headers.get('mcp-session-id')
  const initB = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(initB.status, 200)
  const sidB = initB.headers.get('mcp-session-id')
  assert.notEqual(sidA, sidB, 'two distinct MCP sessions')
  assert.equal(scopes.count(), 1, 'only one DSH execution scope created')

  const callA = await rpc(`${base}/mcp`, toolsCall(3, 'read', { file_path: 'README.md' }), { ...auth, 'Mcp-Session-Id': sidA })
  const callB = await rpc(`${base}/mcp`, toolsCall(4, 'read', { file_path: 'package.json' }), { ...auth, 'Mcp-Session-Id': sidB })
  assert.equal(callA.status, 200)
  assert.equal(callB.status, 200)
  assert.equal(executeCalls.length, 2)
  assert.strictEqual(executeCalls[0].agent.session, executeCalls[1].agent.session, 'both MCP sessions share one agent.session')
})

test('bridge: different conversations never share state', async (t) => {
  const { tools, executeCalls } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const initA = await rpc(`${base}/mcp`, initialize(1), authHeaders('U', 'C1'))
  const initB = await rpc(`${base}/mcp`, initialize(2), authHeaders('U', 'C2'))
  assert.equal(initA.status, 200)
  assert.equal(initB.status, 200)
  assert.equal(scopes.count(), 2, 'C1 and C2 get separate scopes')

  const callA = await rpc(`${base}/mcp`, toolsCall(3, 'read', { file_path: 'a.md' }), { ...authHeaders('U', 'C1'), 'Mcp-Session-Id': initA.headers.get('mcp-session-id') })
  const callB = await rpc(`${base}/mcp`, toolsCall(4, 'read', { file_path: 'b.md' }), { ...authHeaders('U', 'C2'), 'Mcp-Session-Id': initB.headers.get('mcp-session-id') })
  assert.equal(callA.status, 200)
  assert.equal(callB.status, 200)
  assert.notStrictEqual(executeCalls[0].agent.session, executeCalls[1].agent.session, 'different conversations do not share agent.session')
})

test('bridge: different subjects never share state', async (t) => {
  const { tools, executeCalls } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const initA = await rpc(`${base}/mcp`, initialize(1), authHeaders('U1', 'C'))
  const initB = await rpc(`${base}/mcp`, initialize(2), authHeaders('U2', 'C'))
  assert.equal(initA.status, 200)
  assert.equal(initB.status, 200)
  assert.equal(scopes.count(), 2, 'U1 and U2 get separate scopes')

  const callA = await rpc(`${base}/mcp`, toolsCall(3, 'read', { file_path: 'a.md' }), { ...authHeaders('U1', 'C'), 'Mcp-Session-Id': initA.headers.get('mcp-session-id') })
  const callB = await rpc(`${base}/mcp`, toolsCall(4, 'read', { file_path: 'b.md' }), { ...authHeaders('U2', 'C'), 'Mcp-Session-Id': initB.headers.get('mcp-session-id') })
  assert.equal(callA.status, 200)
  assert.equal(callB.status, 200)
  assert.notStrictEqual(executeCalls[0].agent.session, executeCalls[1].agent.session, 'different subjects do not share agent.session')
})

test('bridge: generic fallback keeps P1-A per-MCP-session isolation', async (t) => {
  const { tools, executeCalls } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders() // no identity headers at all
  const initA = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(initA.status, 200)
  const sidA = initA.headers.get('mcp-session-id')
  assert.equal(scopes.count(), 1)

  const callA = await rpc(`${base}/mcp`, toolsCall(3, 'read', { file_path: 'a.md' }), { ...auth, 'Mcp-Session-Id': sidA })
  assert.equal(callA.status, 200)

  // DELETE disposes the temporary scope (P1-A behavior preserved)
  const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...auth, 'Mcp-Session-Id': sidA } })
  assert.ok(del.status === 200 || del.status === 204, `DELETE accepted (${del.status})`)
  assert.equal(fake.history.detached.length, 1, 'fallback scope disposed on DELETE')

  const initB = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(initB.status, 200)
  assert.equal(scopes.count(), 2, 'a fresh MCP session gets a fresh temporary scope')
  const callB = await rpc(`${base}/mcp`, toolsCall(4, 'read', { file_path: 'b.md' }), { ...auth, 'Mcp-Session-Id': initB.headers.get('mcp-session-id') })
  assert.equal(callB.status, 200)
  assert.notStrictEqual(executeCalls[0].agent.session, executeCalls[1].agent.session, 'no identity → per-session isolation')
})

test('bridge: a single identity header falls back to generic behavior', async (t) => {
  const { tools, executeCalls } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  // only x-openai-session → fallback
  const onlySession = authHeaders(undefined, 'C')
  const init1 = await rpc(`${base}/mcp`, initialize(1), onlySession)
  assert.equal(init1.status, 200)
  const init2 = await rpc(`${base}/mcp`, initialize(2), onlySession)
  assert.equal(init2.status, 200)
  assert.equal(scopes.count(), 2, 'only x-openai-session → new scope per MCP session')

  // only x-openai-subject → fallback
  const onlySubject = authHeaders('U', undefined)
  const init3 = await rpc(`${base}/mcp`, initialize(3), onlySubject)
  assert.equal(init3.status, 200)
  const init4 = await rpc(`${base}/mcp`, initialize(4), onlySubject)
  assert.equal(init4.status, 200)
  assert.equal(scopes.count(), 4, 'only x-openai-subject → new scope per MCP session')

  const call1 = await rpc(`${base}/mcp`, toolsCall(5, 'read', { file_path: 'a.md' }), { ...onlySession, 'Mcp-Session-Id': init1.headers.get('mcp-session-id') })
  const call3 = await rpc(`${base}/mcp`, toolsCall(6, 'read', { file_path: 'b.md' }), { ...onlySubject, 'Mcp-Session-Id': init3.headers.get('mcp-session-id') })
  assert.equal(call1.status, 200)
  assert.equal(call3.status, 200)
  assert.notStrictEqual(executeCalls[0].agent.session, executeCalls[1].agent.session, 'partial headers must not enable bridging')
})

test('bridge: observation continuity — read then edit across MCP sessions', async (t) => {
  const { tools, executeCalls } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const initA = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(initA.status, 200)
  const sidA = initA.headers.get('mcp-session-id')

  const read = await rpc(`${base}/mcp`, toolsCall(2, 'read', { file_path: 'README.md' }), { ...auth, 'Mcp-Session-Id': sidA })
  assert.equal(read.status, 200)
  assert.equal(executeCalls.length, 1)

  // MCP session A ends without destroying the stable DSH session.
  const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...auth, 'Mcp-Session-Id': sidA } })
  assert.ok(del.status === 200 || del.status === 204, `DELETE accepted (${del.status})`)
  assert.equal(fake.history.detached.length, 0, 'stable scope survives MCP DELETE')

  // A fresh MCP session from the same conversation reuses the same scope.
  const initB = await rpc(`${base}/mcp`, initialize(3), auth)
  assert.equal(initB.status, 200)
  assert.equal(scopes.count(), 1, 'no new scope for the same identity')
  const sidB = initB.headers.get('mcp-session-id')

  const edit = await rpc(`${base}/mcp`, toolsCall(4, 'edit', { file_path: 'README.md', old_string: 'x', new_string: 'y' }), { ...auth, 'Mcp-Session-Id': sidB })
  assert.equal(edit.status, 200)
  assert.equal(executeCalls.length, 2)
  assert.strictEqual(
    executeCalls[1].agent.session,
    executeCalls[0].agent.session,
    'edit sees the same agent.session as the earlier read → observation state carries over',
  )
})

test('bridge: MCP DELETE does not dispose the stable scope', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const initA = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(initA.status, 200)
  const sidA = initA.headers.get('mcp-session-id')
  assert.equal(scopes.count(), 1)

  const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...auth, 'Mcp-Session-Id': sidA } })
  assert.ok(del.status === 200 || del.status === 204, `DELETE accepted (${del.status})`)
  assert.equal(fake.history.detached.length, 0, 'no scope dispose on DELETE')

  // Same identity reuses the still-live scope.
  const initB = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(initB.status, 200)
  assert.equal(scopes.count(), 1, 'scope reused after DELETE')
  assert.equal(fake.live.size, 1, 'one DSH session still live')
})

test('bridge: idle cleanup disposes unused bridge sessions', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const initA = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(initA.status, 200)
  assert.equal(scopes.count(), 1)

  const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...auth, 'Mcp-Session-Id': initA.headers.get('mcp-session-id') } })
  assert.ok(del.status === 200 || del.status === 204)
  assert.equal(fake.history.detached.length, 0, 'released, not disposed, on DELETE')

  await wait(150) // > idleMs(30) with a 5ms sweep

  const initB = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(initB.status, 200)
  assert.equal(scopes.count(), 2, 'idle session was reclaimed; a fresh scope was created')
  assert.equal(fake.history.detached.length, 1, 'the idle scope was disposed exactly once')
})

test('bridge: active lease prevents idle cleanup', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const initA = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(initA.status, 200)
  assert.equal(scopes.count(), 1)

  await wait(150) // longer than idleMs; the lease is still held

  const initB = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(initB.status, 200)
  assert.equal(scopes.count(), 1, 'leased session survives the idle window')
  assert.equal(fake.history.detached.length, 0, 'no dispose while leased')
})

test('bridge: server close disposes every stable scope exactly once', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const initX = await rpc(`${base}/mcp`, initialize(1), authHeaders('U', 'C1'))
  const initY = await rpc(`${base}/mcp`, initialize(2), authHeaders('V', 'C2'))
  assert.equal(initX.status, 200)
  assert.equal(initY.status, 200)
  assert.equal(scopes.count(), 2)
  assert.equal(fake.live.size, 2)

  await server.close()
  assert.equal(fake.live.size, 0, 'no DSH session leak on shutdown')
  assert.equal(fake.history.detached.length, 2, 'each stable scope disposed once')

  await server.close() // idempotent
  assert.equal(fake.history.detached.length, 2, 'no double dispose on second close')
})

test('bridge: concurrent getOrCreate creates a single scope', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const inits = await Promise.all(
    Array.from({ length: 5 }, (_, i) => rpc(`${base}/mcp`, initialize(i + 1), auth)),
  )
  for (const init of inits) assert.equal(init.status, 200)
  const ids = new Set(inits.map((init) => init.headers.get('mcp-session-id')))
  assert.equal(ids.size, 5, 'five distinct MCP sessions')
  assert.equal(scopes.count(), 1, 'concurrent acquires created exactly one scope')
  assert.equal(fake.live.size, 1, 'one DSH session backing all five MCP sessions')
})

test('bridge: scope creation failure leaves no store entry', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  fake.service.announce = () => { throw new Error('listener vetoed') }
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const bad = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(bad.status, 500, 'scope creation failure surfaces as 500')
  assert.equal(fake.live.size, 0, 'nothing leaked into the DSH store')

  // A later request with the same identity must be able to retry cleanly.
  fake.service.announce = (session) => { /* accept again */ }
  const ok = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(ok.status, 200)
  assert.equal(scopes.count(), 2, 'one failed attempt + one successful retry')
  assert.equal(fake.live.size, 1, 'the failed identity left no stale store entry')
})

test('bridge: failed initialize does not leak a lease', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    ...FAST_IDLE,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  // Malformed initialize: the bridge session is acquired, then the protocol
  // initialize fails and the session must release its lease.
  const bad = await rpc(`${base}/mcp`, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26' },
  }, auth)
  assert.equal(bad.status, 400)

  const init = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(init.status, 200)
  assert.equal(scopes.count(), 1, 'same identity reused the scope created for the failed attempt')

  const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...auth, 'Mcp-Session-Id': init.headers.get('mcp-session-id') } })
  assert.ok(del.status === 200 || del.status === 204)
  await wait(150)

  // If the failed attempt had leaked its lease, this session would never be
  // idle-reclaimed; a fresh scope means the lease accounting is correct.
  const init2 = await rpc(`${base}/mcp`, initialize(3), auth)
  assert.equal(init2.status, 200)
  assert.equal(scopes.count(), 2, 'no lease leaked from the failed initialize')
})

test('bridge store unit: duplicate release and idempotent dispose', async () => {
  const fake = fakeSessions()
  const store = createBridgeSessionStore({
    createScope: () => createSessionExecutionScope(fake.service),
    idleMs: 1000,
    cleanupIntervalMs: 50,
    log: () => {},
  })
  const identity = { provider: 'test', key: 'k1' }
  const { session, created } = await store.acquire(identity)
  assert.equal(created, true)
  assert.equal(session.leaseCount, 1)

  store.release(session)
  store.release(session)
  store.release(session)
  assert.equal(session.leaseCount, 0, 'duplicate release never goes negative')

  await store.disposeAll()
  assert.equal(session.disposed, true)
  assert.equal(fake.history.detached.length, 1, 'scope disposed exactly once')
  await store.disposeAll()
  assert.equal(fake.history.detached.length, 1, 'disposeAll is idempotent')
  store.stopCleanup()
})

test('bridge: diagnostics report bridge identity fields without raw values', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const lines = []
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    diagnosticRequests: true,
    log: (m) => lines.push(m),
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('diag-subject-value', 'diag-session-value')
  const initA = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(initA.status, 200)
  const initB = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(initB.status, 200)
  const initGeneric = await rpc(`${base}/mcp`, initialize(3), authHeaders())
  assert.equal(initGeneric.status, 200)

  const rows = lines
    .filter((l) => l.startsWith('[chatgpt-dsh][diag]'))
    .map((l) => JSON.parse(l.slice('[chatgpt-dsh][diag]'.length)))
  const requests = rows.filter((r) => r.event === 'request' && r.mcpMethod === 'initialize')
  assert.equal(requests.length, 3)

  assert.equal(requests[0].bridgeIdentityResolved, true)
  assert.match(requests[0].bridgeSession, /^bridge-\d+$/)
  assert.equal(requests[0].bridgeSessionCreated, true)
  assert.equal(requests[1].bridgeIdentityResolved, true)
  assert.equal(requests[1].bridgeSession, requests[0].bridgeSession, 'reuse reports the same bridge session')
  assert.equal(requests[1].bridgeSessionCreated, false)
  assert.equal(requests[2].bridgeIdentityResolved, false)
  assert.equal(requests[2].bridgeSession, null)

  assert.match(requests[0].identity['x-openai-subject'], /^sha256:[0-9a-f]{16}$/)
  assert.match(requests[0].identity['x-openai-session'], /^sha256:[0-9a-f]{16}$/)
  assert.equal(requests[1].identity['x-openai-subject'], requests[0].identity['x-openai-subject'], 'stable subject fingerprint is comparable')
  assert.equal(requests[1].identity['x-openai-session'], requests[0].identity['x-openai-session'], 'stable session fingerprint is comparable')

  // Neither diagnostic nor plain logs may contain the raw stable upstream ids.
  const allLogs = lines.join('\n')
  assert.ok(!allLogs.includes('diag-subject-value'), 'raw x-openai-subject never logged')
  assert.ok(!allLogs.includes('diag-session-value'), 'raw x-openai-session never logged')
})

test('mcp idle config parsing', () => {
  assert.equal(parseMcpSessionIdleMs(undefined), DEFAULT_MCP_SESSION_IDLE_MS)
  assert.equal(parseMcpSessionIdleMs('5000'), 5000)
  assert.equal(parseMcpSessionIdleMs('0'), DEFAULT_MCP_SESSION_IDLE_MS)
  assert.equal(parseMcpSessionIdleMs('-5'), DEFAULT_MCP_SESSION_IDLE_MS)
  assert.equal(parseMcpSessionIdleMs('abc'), DEFAULT_MCP_SESSION_IDLE_MS)
  assert.equal(parseMcpSessionIdleMs('1.5'), DEFAULT_MCP_SESSION_IDLE_MS)
})

test('bridge store: provider namespace isolates same key across providers', async () => {
  const fake = fakeSessions()
  const store = createBridgeSessionStore({
    createScope: () => createSessionExecutionScope(fake.service),
    idleMs: 1000,
    cleanupIntervalMs: 50,
    log: () => {},
  })
  const openAi = await store.acquire({ provider: 'openai', key: 'same' })
  const other = await store.acquire({ provider: 'test', key: 'same' })
  assert.equal(openAi.created, true)
  assert.equal(other.created, true)
  assert.notStrictEqual(openAi.session, other.session, 'identical opaque keys under different providers must not collide')
  assert.equal(fake.history.prepared.length, 2, 'two distinct DSH scopes')
  assert.equal(openAi.session.identity.key, other.session.identity.key, 'both identities share the same opaque key by design')
  assert.equal(fake.history.detached.length, 0)
  await store.disposeAll()
  assert.equal(fake.history.detached.length, 2, 'each scope disposed exactly once')
  store.stopCleanup()
})

test('mcp stale cleanup without DELETE: leases drain, bridge scope reclaimed', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    // MCP sessions go stale fast; bridge idle is long enough to observe the
    // two-stage lifecycle (lease drain → bridge dispose).
    mcpSessionIdleMs: 30,
    mcpSessionCleanupIntervalMs: 5,
    bridgeSessionIdleMs: 200,
    bridgeSessionCleanupIntervalMs: 10,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const inits = await Promise.all([
    rpc(`${base}/mcp`, initialize(1), auth),
    rpc(`${base}/mcp`, initialize(2), auth),
    rpc(`${base}/mcp`, initialize(3), auth),
  ])
  for (const init of inits) assert.equal(init.status, 200)
  const sids = inits.map((init) => init.headers.get('mcp-session-id'))
  assert.equal(scopes.count(), 1, 'one stable scope for the identity')
  assert.equal(fake.live.size, 1)

  // No DELETE anywhere. After the MCP idle window, all three MCP sessions are
  // stale-closed; the stable scope must still be alive (lease drained, but
  // bridge idle not reached yet).
  await wait(120)
  for (const sid of sids) {
    assert.equal((await rpc(`${base}/mcp`, toolsList(), { ...auth, 'Mcp-Session-Id': sid })).status, 404, 'stale MCP session removed from routing')
  }
  assert.equal(scopes.count(), 1, 'bridge scope survives the MCP idle phase')
  assert.equal(fake.history.detached.length, 0)

  // After the bridge idle window, the stable scope is disposed exactly once.
  await wait(250)
  assert.equal(fake.history.detached.length, 1, 'bridge scope disposed exactly once')

  // A fresh MCP session for the same identity gets a brand new scope.
  const initD = await rpc(`${base}/mcp`, initialize(4), auth)
  assert.equal(initD.status, 200)
  assert.equal(scopes.count(), 2, 'the reclaimed identity starts a fresh bridge session')
})

test('mcp stale cleanup: active requests keep the session and lease alive', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    mcpSessionIdleMs: 120,
    mcpSessionCleanupIntervalMs: 5,
    bridgeSessionIdleMs: 1000,
    bridgeSessionCleanupIntervalMs: 50,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const init = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(init.status, 200)
  const sid = init.headers.get('mcp-session-id')

  // Keep sending requests every 40ms (idle = 120ms); the total span far
  // exceeds the idle window, but lastUsedAt keeps refreshing.
  for (let i = 0; i < 6; i += 1) {
    await wait(40)
    const list = await rpc(`${base}/mcp`, toolsList(i + 2), { ...auth, 'Mcp-Session-Id': sid })
    assert.equal(list.status, 200, 'session stays routable while requests keep coming')
  }
  assert.equal(scopes.count(), 1, 'lease held the whole time; no new scope')

  // Now stop requesting: the session goes stale and the lease drains.
  await wait(300)
  assert.equal((await rpc(`${base}/mcp`, toolsList(99), { ...auth, 'Mcp-Session-Id': sid })).status, 404, 'session reclaimed once quiet')
  assert.equal(scopes.count(), 1)
})

test('mcp stale cleanup: generic fallback scope disposed without DELETE', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    mcpSessionIdleMs: 30,
    mcpSessionCleanupIntervalMs: 5,
    bridgeSessionIdleMs: 1000,
    bridgeSessionCleanupIntervalMs: 50,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders() // no identity → P1-A fallback
  const init = await rpc(`${base}/mcp`, initialize(1), auth)
  assert.equal(init.status, 200)
  const sid = init.headers.get('mcp-session-id')
  assert.equal(scopes.count(), 1)
  assert.equal(fake.live.size, 1)

  // No DELETE: the stale sweep must close the MCP session and dispose its
  // temporary execution scope (P1-A semantics without client cooperation).
  await wait(120)
  assert.equal((await rpc(`${base}/mcp`, toolsList(2), { ...auth, 'Mcp-Session-Id': sid })).status, 404, 'fallback session reclaimed')
  assert.equal(fake.live.size, 0, 'temporary scope disposed by stale cleanup')
  assert.equal(fake.history.detached.length, 1)
})

test('shutdown after stale cleanup never double disposes', async (t) => {
  const { tools } = mockTools()
  const fake = fakeSessions()
  const scopes = countingScopes(fake)
  const server = await startHttpMcpServer({
    tools, token: TOKEN, port: 0,
    createExecutionScope: scopes.create,
    mcpSessionIdleMs: 30,
    mcpSessionCleanupIntervalMs: 5,
    bridgeSessionIdleMs: 1000,
    bridgeSessionCleanupIntervalMs: 50,
  })
  const base = server.url.replace(/\/mcp$/, '')
  t.after(async () => { await server.close() })

  const auth = authHeaders('U', 'C')
  const initA = await rpc(`${base}/mcp`, initialize(1), auth)
  const initB = await rpc(`${base}/mcp`, initialize(2), auth)
  assert.equal(initA.status, 200)
  assert.equal(initB.status, 200)
  assert.equal(scopes.count(), 1)

  // Let the stale sweep close both MCP sessions (leases drained) while the
  // stable bridge scope is still alive, then shut down.
  await wait(120)
  assert.equal(fake.history.detached.length, 0, 'bridge scope alive at shutdown time')

  await server.close()
  assert.equal(fake.history.detached.length, 1, 'shutdown disposed the scope exactly once')

  await server.close() // idempotent
  assert.equal(fake.history.detached.length, 1, 'no double dispose on second close')
})

test('bridge store: sweep/acquire race — acquire never returns an evicted session', async () => {
  // Deterministic construction: a controllable clock makes the old session
  // idle-eligible immediately, and the beforeSessionRevalidate gate holds
  // the acquire in flight across a real sweep tick, which then evicts the
  // old session while acquire is awaiting it.
  const fake = fakeSessions()
  let clock = 0
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  const store = createBridgeSessionStore({
    createScope: () => createSessionExecutionScope(fake.service),
    idleMs: 1000,
    cleanupIntervalMs: 5,
    now: () => clock,
    log: () => {},
    beforeSessionRevalidate: async () => { await gate },
  })
  const identity = { provider: 'openai', key: 'k1' }

  // Stage 1: create the old session and make it idle-eligible (lease 0,
  // lastUsedAt far beyond the idle window on the injected clock).
  const first = await store.acquire(identity)
  const old = first.session
  store.release(old)
  assert.equal(old.leaseCount, 0)
  clock += 5000

  // Stage 2: acquire re-reads the old session from the map, then hangs on
  // the gate. Meanwhile the sweep (5ms interval, clock-based) evicts old.
  const acquiring = store.acquire(identity)
  await wait(30)
  assert.equal(old.disposed, true, 'sweep evicted the old session while acquire was in flight')
  releaseGate()
  const acquired = await acquiring
  const fresh = acquired.session

  assert.notStrictEqual(fresh, old, 'acquire must not return the evicted session')
  assert.equal(acquired.created, true, 'a fresh session was created instead')
  assert.equal(fresh.disposed, false)
  assert.equal(fresh.leaseCount, 1, 'new session is leased and usable')
  assert.equal(fake.history.detached.length, 1, 'old session disposed exactly once')

  // The fresh session works normally through the store lifecycle.
  store.release(fresh)
  await store.disposeAll()
  assert.equal(fake.history.detached.length, 2, 'fresh session disposed exactly once by disposeAll')
  store.stopCleanup()
})
