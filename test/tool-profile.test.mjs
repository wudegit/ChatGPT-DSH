/**
 * P2-C2 Core Tool Profile tests: MCP annotations, DSH schema authority,
 * startup registry contract validation, extra-tool filtering, and execution
 * delegation back to the DSH Tool Runtime.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttpMcpServer } from '../src/http-server.ts'
import { apply } from '../src/index.ts'

const TOKEN = 'p2-c2-test-token'

const writeSchema = {
  name: 'write',
  description: 'DSH write description',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
}

const editSchema = {
  name: 'edit',
  description: 'DSH edit description',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
}

function mockTools(schemas) {
  const executeCalls = []
  return {
    tools: {
      schemas: () => schemas,
      async execute(input) {
        executeCalls.push(input)
        return {
          isError: false,
          value: 'ok',
          content: [{ type: 'text', text: `dsh:${input.name}` }],
        }
      },
    },
    executeCalls,
  }
}

async function unusedPort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  assert.ok(typeof address === 'object' && address !== null)
  const port = address.port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function assertPortCanBind(port) {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => probe.close(resolve))
}

test('P2-C2: tools/list combines DSH schemas with Core Profile annotations and ignores extra tools', async (t) => {
  const readParameters = {
    type: 'object',
    properties: { source_path: { type: 'string', description: 'mock-controlled field' } },
    required: ['source_path'],
  }
  const schemas = [
    {
      name: 'read',
      description: 'description supplied only by the mock DSH registry',
      parameters: readParameters,
    },
    writeSchema,
    editSchema,
    { name: 'glob', description: 'must stay hidden', parameters: { type: 'object', properties: {} } },
    { name: 'pwsh', description: 'must stay hidden', parameters: { type: 'object', properties: {} } },
  ]
  const { tools, executeCalls } = mockTools(schemas)
  const server = await startHttpMcpServer({ tools, token: TOKEN, port: 0 })

  const client = new Client({ name: 'p2-c2-test', version: '0.0.1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }))
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), ['read', 'write', 'edit'])

  const read = listed.tools.find(tool => tool.name === 'read')
  const write = listed.tools.find(tool => tool.name === 'write')
  const edit = listed.tools.find(tool => tool.name === 'edit')
  assert.ok(read && write && edit)

  assert.equal(read.description, schemas[0].description)
  assert.deepEqual(read.inputSchema, readParameters)
  assert.deepEqual(read.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  assert.deepEqual(write.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  })
  assert.deepEqual(edit.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  })
  assert.ok(listed.tools.every(tool => !('securitySchemes' in tool)))

  const result = await client.callTool({ name: 'read', arguments: { source_path: 'README.md' } })
  assert.equal(result.content[0]?.text, 'dsh:read')
  assert.equal(executeCalls.length, 1)
  assert.equal(executeCalls[0].name, 'read')
  assert.deepEqual(executeCalls[0].arguments, { source_path: 'README.md' })

  const hiddenResult = await client.callTool({ name: 'glob', arguments: {} })
  assert.equal(hiddenResult.isError, true)
  assert.match(hiddenResult.content[0]?.text ?? '', /not exposed by this bridge/)
  assert.equal(executeCalls.length, 1, 'an extra DSH tool never reaches tools.execute')
})

test('P2-C2: missing required DSH tool fails before the MCP listener starts', async () => {
  const port = await unusedPort()
  const logs = []
  const { tools } = mockTools([
    { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } },
    writeSchema,
  ])

  await assert.rejects(
    startHttpMcpServer({ tools, token: TOKEN, port, log: message => logs.push(message) }),
    /missing required DSH tools: edit/,
  )
  assert.ok(!logs.some(line => line.includes('HTTP MCP Server listening')))
  await assertPortCanBind(port)
})

test('P2-C2: duplicate DSH tool name fails closed', async () => {
  const { tools } = mockTools([
    { name: 'read', description: 'first read', parameters: { type: 'object', properties: {} } },
    { name: 'read', description: 'second read', parameters: { type: 'object', properties: {} } },
    writeSchema,
    editSchema,
  ])

  await assert.rejects(
    startHttpMcpServer({ tools, token: TOKEN, port: 0 }),
    /duplicate DSH tool names: read/,
  )
})

test('P2-C2: registry contract failure stays isolated to the Bridge plugin', async (t) => {
  const previousToken = process.env.CHATGPT_DSH_TOKEN
  process.env.CHATGPT_DSH_TOKEN = TOKEN
  t.after(() => {
    if (previousToken === undefined) delete process.env.CHATGPT_DSH_TOKEN
    else process.env.CHATGPT_DSH_TOKEN = previousToken
  })

  const errorLines = []
  let effectPromise
  const originalConsoleError = console.error
  console.error = message => errorLines.push(String(message))
  t.after(() => { console.error = originalConsoleError })

  const { tools } = mockTools([
    { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } },
    writeSchema,
  ])
  const ctx = {
    tools,
    sessions: {},
    logger: {
      info() {},
      error(message) { errorLines.push(String(message)) },
    },
    effect(run) {
      effectPromise = Promise.resolve().then(run)
      return { dispose() {} }
    },
  }

  apply(ctx)
  await assert.doesNotReject(effectPromise)
  assert.ok(errorLines.some(line => line.includes('HTTP MCP Server not started')))
  assert.ok(errorLines.some(line => line.includes('missing required DSH tools: edit')))
})
