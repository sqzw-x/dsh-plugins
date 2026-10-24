import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

import {
  PromptStore,
  SectionRegistrar,
  buildPreview,
  emptyState,
  registerRoutes,
} from '../lib/index.js'

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

/** A `webServer` that records routes instead of binding a socket. */
class FakeWebServer extends Service {
  routes = []

  constructor(ctx) {
    super(ctx, 'webServer')
  }

  register(route) {
    this.routes.push(route)
    return () => {
      this.routes = this.routes.filter((entry) => entry !== route)
    }
  }

  route(path) {
    const found = this.routes.find((entry) => entry.path === path)
    assert.ok(found, `route ${path} is registered (have: ${this.routes.map((entry) => entry.path).join(', ')})`)
    return found
  }
}

/** A request carrying an optional JSON body. */
function request(method, body, headers = {}) {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))])
  return Object.assign(stream, {
    method,
    headers: {
      host: '127.0.0.1:54587',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...headers,
    },
    url: '/',
  })
}

/** A response capturing status, headers and body. */
function response() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    get statusCode() {
      return captured.status
    },
    set statusCode(value) {
      captured.status = value
    },
    setHeader(name, value) {
      captured.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      captured.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

/** Mount the routes over a temp store and return a caller helper. */
async function withRoutes(t) {
  const dir = mkdtempSync(join(tmpdir(), 'system-prompt-insertion-routes-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify(emptyState()), 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const ctx = new Context()
  ctx.plugin(SystemPrompt, { personaPrefix: 'PERSONA', includeRuntimeContext: false })
  ctx.plugin(FakeWebServer)
  await tick()

  const store = new PromptStore({ path: file, logger: ctx.logger })
  const registrar = new SectionRegistrar(ctx, store, ctx.logger)
  registrar.sync()
  registerRoutes(ctx, {
    store,
    registrar,
    logger: ctx.logger,
    preview: () => buildPreview({ ctx, store, registrar, maxSectionBytes: 8192 }),
  })
  await tick()

  const call = async (path, method, body, headers) => {
    const res = response()
    await ctx.webServer.route(path).handler(request(method, body, headers), res)
    const captured = res.captured
    return {
      status: captured.status,
      headers: captured.headers,
      json: captured.body === '' ? undefined : JSON.parse(captured.body),
    }
  }
  return { ctx, file, call, registrar, store }
}

test('GET /state returns the document, path and registered names', async (t) => {
  const { call } = await withRoutes(t)
  const result = await call('/dsh-system-prompt-insertion/state', 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.state, emptyState())
  assert.match(result.json.path, /state\.json$/)
  assert.deepEqual(result.json.registered, [])
  assert.equal(result.json.orderBases.tailBase, 10200)
})

test('POST /state persists, registers and answers with the new document', async (t) => {
  const { call, file, registrar } = await withRoutes(t)
  const document = {
    version: 1,
    enabled: true,
    sections: [{
      id: 's-abcdef',
      title: 'Rules',
      text: 'SAVED-TEXT',
      position: 'tail',
      order: null,
      enabled: true,
      interpolate: false,
    }],
  }
  const result = await call('/dsh-system-prompt-insertion/state', 'POST', document)
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.registered, ['user:system-prompt-insertion:s-abcdef'])
  assert.deepEqual(registrar.registeredNames(), ['user:system-prompt-insertion:s-abcdef'])
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sections[0].text, 'SAVED-TEXT')
})

test('POST /state rejects an invalid document with 422 and keeps the file intact', async (t) => {
  const { call, file } = await withRoutes(t)
  const before = readFileSync(file, 'utf8')
  const result = await call('/dsh-system-prompt-insertion/state', 'POST', {
    version: 1,
    enabled: true,
    sections: [{ id: 'NOPE', title: 'x', text: 'y', position: 'tail', order: null, enabled: true, interpolate: false }],
  })
  assert.equal(result.status, 422)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'invalid-state')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('writes require JSON and a same-origin request', async (t) => {
  const { call } = await withRoutes(t)
  const wrongType = await call('/dsh-system-prompt-insertion/state', 'POST', undefined, { 'content-type': 'text/plain' })
  // No body means no content-type header was synthesized; the handler still
  // refuses a non-JSON write.
  assert.equal(wrongType.status, 415)

  const crossSite = await call('/dsh-system-prompt-insertion/state', 'POST', emptyState(), { origin: 'https://evil.example' })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.error.code, 'cross-origin')

  const sameSite = await call('/dsh-system-prompt-insertion/state', 'POST', emptyState(), { origin: 'http://127.0.0.1:54587' })
  assert.equal(sameSite.status, 200)
})

test('GET /preview assembles the current prompt', async (t) => {
  const { call } = await withRoutes(t)
  await call('/dsh-system-prompt-insertion/state', 'POST', {
    version: 1,
    enabled: true,
    sections: [{
      id: 's-abcdef',
      title: 'Rules',
      text: 'PREVIEW-FROM-ROUTE',
      position: 'tail',
      order: null,
      enabled: true,
      interpolate: false,
    }],
  })
  const result = await call('/dsh-system-prompt-insertion/preview', 'GET')
  assert.equal(result.status, 200)
  assert.match(result.json.rendered, /PREVIEW-FROM-ROUTE/)
  assert.ok(Array.isArray(result.json.sections))
  assert.ok(result.json.sections.some((entry) => entry.ours === true))
})

test('an unsupported method is refused with 405', async (t) => {
  const { call } = await withRoutes(t)
  const result = await call('/dsh-system-prompt-insertion/state', 'DELETE')
  assert.equal(result.status, 405)
  assert.equal(result.json.error.code, 'method-not-allowed')
  assert.match(String(result.headers.allow), /GET, POST/)
})
