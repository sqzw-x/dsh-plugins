/**
 * Test doubles and artifact contracts shared by every plugin here.
 *
 * The three things each plugin otherwise re-invents:
 *
 * 1. waiting for cordis effects to settle after mounting a plugin;
 * 2. a `webServer` you can drive without binding a socket (so route logic is
 *    unit-testable, including the origin/content-type guards);
 * 3. the artifact contract of a DSH bundle — the client half must be the lazy
 *    `window.__ModuleLoader__.load` factory with the package name as its id, and
 *    the host half must export `apply`. Both failures are silent at runtime, so
 *    they are asserted in CI instead.
 *
 * @module dsh-plugin-toolkit/test
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { Service } from '@deepseek-ai/cordis'

/**
 * Wait for the current macrotask queue to drain, so cordis has applied effects.
 * @param {number} [ms] - settle window in milliseconds.
 * @returns {Promise<void>} resolves after the window.
 */
export function tick(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A `webServer` double that records routes instead of binding a socket.
 *
 * Mount it with `ctx.plugin(FakeWebServer)`, then drive a recorded route through
 * {@link callRoute}. It implements the one method under test (`register`) and
 * returns the disposer the real service returns.
 */
export class FakeWebServer extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - mounting context.
   */
  constructor(ctx) {
    super(ctx, 'webServer')
    /** @type {Array<{ kind: string, path: string, handler: Function }>} */
    this.routes = []
  }

  /**
   * Record one route.
   * @param {{ kind: string, path: string, handler: Function }} route - the route.
   * @returns {() => void} disposer.
   */
  register(route) {
    this.routes.push(route)
    return () => {
      this.routes = this.routes.filter((entry) => entry !== route)
    }
  }

  /**
   * The recorded route for a path.
   * @param {string} path - exact path.
   * @returns {{ kind: string, path: string, handler: Function }} the route.
   */
  route(path) {
    const found = this.routes.find((entry) => entry.path === path)
    if (found === undefined) {
      throw new Error(`route ${path} is not registered (have: ${this.routes.map((entry) => entry.path).join(', ') || 'none'})`)
    }
    return found
  }
}

/**
 * Build a request for a recorded route.
 * @param {string} method - HTTP method.
 * @param {unknown} [body] - JSON body; omitted means an empty request.
 * @param {Record<string, string>} [headers] - extra headers (host defaults to loopback).
 * @returns {import('node:http').IncomingMessage} a request-shaped readable.
 */
export function makeRequest(method, body, headers = {}) {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))])
  return Object.assign(stream, {
    method,
    headers: {
      host: '127.0.0.1:0',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...headers,
    },
    url: '/',
  })
}

/**
 * Build a response that records what a handler wrote.
 * @returns {object} a response-shaped object; `captured` holds status, headers and body.
 */
export function makeResponse() {
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
      captured.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      captured.body = chunk === undefined || chunk === null ? '' : String(chunk)
    },
  }
}

/**
 * Invoke a recorded route the way the web server would.
 * @param {{ handler: Function }} route - the route to call.
 * @param {string} method - HTTP method.
 * @param {unknown} [body] - JSON body.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {Promise<{ status: number, headers: Record<string, string>, json: unknown, body: string }>} the response.
 */
export async function callRoute(route, method, body, headers) {
  const response = makeResponse()
  await route.handler(makeRequest(method, body, headers), response)
  const { status, headers: responseHeaders, body: text } = response.captured
  let json
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status, headers: responseHeaders, json, body: text }
}

/**
 * Assert the browser half is a loadable module-table entry.
 *
 * Everything asserted here has a silent failure mode in production: a bundle
 * without the wrapper never loads, a wrapper with the wrong id never matches the
 * roster entry, and a bundle without `apply` registers nothing.
 *
 * @param {string} file - absolute path to the built client bundle.
 * @param {string} id - expected module id, normally the package name.
 * @returns {string} the bundle source.
 */
export function assertClientBundle(file, id) {
  const source = readFileSync(file, 'utf8')
  if (!source.startsWith('window.__ModuleLoader__.load({')) {
    throw new Error(`${file}: missing the window.__ModuleLoader__ wrapper`)
  }
  if (!source.includes(`id: ${JSON.stringify(id)}`)) {
    throw new Error(`${file}: module id is not ${JSON.stringify(id)} (the client roster keys by package name)`)
  }
  if (!/exports\.apply\s*=/.test(source)) throw new Error(`${file}: does not export apply`)
  if (!/exports\.inject\s*=/.test(source)) throw new Error(`${file}: does not export inject`)
  return source
}

/**
 * Assert the host half is importable and exports what the loader needs.
 * @param {string} file - absolute path to the built host entry.
 * @param {object} [options] - expectations.
 * @param {string} [options.name] - expected cordis plugin name.
 * @returns {Promise<Record<string, unknown>>} the imported module.
 */
export async function assertHostBundle(file, { name } = {}) {
  const module = await import(pathToFileURL(file).href)
  if (typeof module.apply !== 'function') throw new Error(`${file}: does not export apply`)
  if (name !== undefined && module.name !== name) {
    throw new Error(`${file}: plugin name is ${JSON.stringify(module.name)}, expected ${JSON.stringify(name)}`)
  }
  return module
}

/**
 * Mount the real prompt registry, for tests that need actual assembly.
 *
 * The registry package is imported lazily so plugins that never touch the prompt
 * do not need it installed.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context to mount on.
 * @param {Record<string, unknown>} [config] - `dsh-system-prompt` configuration.
 * @returns {Promise<{ renderPrompt: Function, assemble: Function }>} helpers bound to the mount.
 */
export async function mountPromptRegistry(ctx, config = {}) {
  const { default: SystemPrompt, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  ctx.plugin(SystemPrompt, { includeRuntimeContext: false, ...config })
  await tick()
  return {
    renderPrompt,
    assemble: (options) => ctx.systemPrompt.assemble(options),
  }
}
