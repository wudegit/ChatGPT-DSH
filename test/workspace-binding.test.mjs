/**
 * P2-B first phase (Workspace Binding) tests: the Host cwd is written into
 * every DSH Execution Session's `SessionHeader.cwd` at creation via the
 * native `prepare(id, { meta: { cwd } })` API — for temporary scopes, for
 * Stable Bridge Sessions (P2-A identity reuse keeps one cwd), and for
 * generic fallback sessions.
 *
 * Runs against `createSessionExecutionScope` and `startHttpMcpServer` with a
 * mocked BridgeToolRuntime and a fake DSH session store — no DSH runtime
 * needed.
 *
 * Run: npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { startHttpMcpServer } from '../src/http-server.ts'
import { createSessionExecutionScope } from '../src/execution-scope.ts'

const TOKEN = 'test-secret'

/** Cross-platform absolute Host workspace (never hardcodes a Windows path). */
const HOST_CWD = resolve('p2b', 'fixture-workspace')
assert.ok(HOST_CWD.startsWith('\\') || HOST_CWD.startsWith('/') || /^[A-Za-z]:[\\/]/.test(HOST_CWD), 'fixture cwd must be absolute')

/** Mock harness tool runtime; records calls for assertions. */
function mockTools() {
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
        return { isError: false, value: 'ok', content: [{ type: 'text', text: `ok:${input.name}` }] }
      },
    },
  }
}

/** Fake DSH session store that records prepare options and keeps a header. */
function fakeSessions() {
  const live = new Map()
  const history = { prepared: [], entered: [], announced: [], detached: [] }
  return {
    live,
    history,
    service: {
      prepare(id, options) {
        history.prepared.push({ id, options })
        return { id, header: { cwd: options?.meta?.cwd } }
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

/** createExecutionScope factory that records every created scope. */
function recordingScopes(fake, cwd) {
  const created = []
  return {
    created,
    create: () => {
      const scope = createSessionExecutionScope(fake.service, { cwd })
      created.push(scope)
      return scope
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

/** Auth header plus optional OpenAI identity headers. */
function authHeaders(subject, session) {
  const headers = { Authorization: `Bearer ${TOKEN}` }
  if (subject !== undefined) headers['x-openai-subject'] = subject
  if (session !== undefined) headers['x-openai-session'] = session
  return headers
}

test('P2-B: ExecutionScope writes cwd into prepare meta and SessionHeader', () => {
  const fake = fakeSessions()
  const scope = createSessionExecutionScope(fake.service, { cwd: HOST_CWD })

  assert.equal(fake.history.prepared.length, 1)
  assert.deepEqual(fake.history.prepared[0].options, { meta: { cwd: HOST_CWD } }, 'prepare received { meta: { cwd } }')
  assert.equal(scope.agent.session.header.cwd, HOST_CWD, 'SessionHeader.cwd equals the injected Host cwd')
  assert.equal(scope.agent.session.id, fake.history.prepared[0].id)
  assert.ok(fake.live.has(scope.agent.id), 'DSH session is live after announce')

  scope.dispose()
})

test('P2-B: omitting cwd keeps the old createSessionExecutionScope call working', () => {
  const fake = fakeSessions()
  const scope = createSessionExecutionScope(fake.service)

  assert.equal(fake.history.prepared.length, 1)
  assert.equal(fake.history.prepared[0].options, undefined, 'no meta is passed when cwd is omitted')
  assert.equal(scope.agent.session.header.cwd, undefined, 'header.cwd stays unset (P1-A behavior)')
  assert.ok(fake.live.has(scope.agent.id), 'session is still created without cwd')

  scope.dispose()
  assert.ok(!fake.live.has(scope.agent.id), 'dispose still detaches')
})

test('P2-B: stable bridge session keeps one scope and one cwd across MCP sessions', async (t) => {
  const fake = fakeSessions()
  const recorder = recordingScopes(fake, HOST_CWD)
  const server = await startHttpMcpServer({
    tools: mockTools().tools,
    token: TOKEN,
    port: 0,
    allow: ['read'],
    createExecutionScope: recorder.create,
  })
  t.after(async () => { await server.close() })
  const base = server.url.replace(/\/mcp$/, '')
  const identity = authHeaders('subject-1', 'conversation-1')

  // Two different MCP sessions, same ChatGPT identity (P2-A reuse).
  for (let i = 0; i < 2; i += 1) {
    const res = await rpc(`${base}/mcp`, initialize(i + 1), identity)
    assert.equal(res.status, 200, `initialize ${i + 1} succeeds`)
  }

  assert.equal(recorder.created.length, 1, 'two MCP sessions share ONE DSH ExecutionScope')
  const scope = recorder.created[0]
  assert.equal(scope.agent.session.header.cwd, HOST_CWD, 'stable session header.cwd equals the Host cwd')
  assert.equal(fake.live.size, 1, 'exactly one live DSH session')
})

test('P2-B: different bridge sessions keep distinct identity but the same cwd', async (t) => {
  const fake = fakeSessions()
  const recorder = recordingScopes(fake, HOST_CWD)
  const server = await startHttpMcpServer({
    tools: mockTools().tools,
    token: TOKEN,
    port: 0,
    allow: ['read'],
    createExecutionScope: recorder.create,
  })
  t.after(async () => { await server.close() })
  const base = server.url.replace(/\/mcp$/, '')

  for (let i = 0; i < 2; i += 1) {
    const res = await rpc(`${base}/mcp`, initialize(i + 1), authHeaders(`subject-${i + 1}`, `conversation-${i + 1}`))
    assert.equal(res.status, 200, `initialize ${i + 1} succeeds`)
  }

  assert.equal(recorder.created.length, 2, 'each identity creates its own DSH ExecutionScope')
  const [a, b] = recorder.created
  assert.notEqual(a.agent.id, b.agent.id, 'session identity differs across bridge sessions')
  assert.notEqual(a.agent.session.id, b.agent.session.id, 'DSH session id differs across bridge sessions')
  assert.equal(a.agent.session.header.cwd, HOST_CWD, 'first session header.cwd equals the Host cwd')
  assert.equal(b.agent.session.header.cwd, HOST_CWD, 'second session header.cwd equals the Host cwd')
  assert.equal(fake.live.size, 2, 'both sessions are live')
})

test('P2-B: generic fallback keeps per-MCP-session isolation and binds the same cwd', async (t) => {
  const fake = fakeSessions()
  const recorder = recordingScopes(fake, HOST_CWD)
  const server = await startHttpMcpServer({
    tools: mockTools().tools,
    token: TOKEN,
    port: 0,
    allow: ['read'],
    createExecutionScope: recorder.create,
  })
  t.after(async () => { await server.close() })
  const base = server.url.replace(/\/mcp$/, '')

  // No x-openai-subject / x-openai-session → no BridgeIdentity → the P1-A
  // generic fallback creates one temporary DSH ExecutionScope per MCP session.
  for (let i = 0; i < 2; i += 1) {
    const res = await rpc(`${base}/mcp`, initialize(i + 1), authHeaders())
    assert.equal(res.status, 200, `initialize ${i + 1} succeeds`)
  }

  assert.equal(recorder.created.length, 2, 'each generic MCP session owns its own ExecutionScope')
  const [a, b] = recorder.created
  assert.notEqual(a, b, 'ExecutionScope A !== ExecutionScope B')
  assert.notEqual(a.agent.session, b.agent.session, 'agent.session A !== agent.session B')
  assert.notEqual(a.agent.session.id, b.agent.session.id, 'DSH session id differs across generic scopes')
  assert.equal(a.agent.session.header.cwd, HOST_CWD, 'generic scope A header.cwd equals the Host cwd')
  assert.equal(b.agent.session.header.cwd, HOST_CWD, 'generic scope B header.cwd equals the Host cwd')
  assert.equal(fake.live.size, 2, 'two independent live DSH sessions')
})