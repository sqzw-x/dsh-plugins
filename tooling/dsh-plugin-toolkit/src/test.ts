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
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** One route recorded by {@link FakeWebServer}. */
export interface TestRoute {
  /** Route kind (`get`, `post`, …), as the web server declares it. */
  kind: string
  /** Exact request path. */
  path: string
  /** Request handler under test. */
  handler: (request: IncomingMessage, response: ServerResponse) => unknown
}

/** What {@link makeResponse} recorded from a handler. */
export interface CapturedResponse {
  /** Status written by the handler. */
  status: number
  /** Headers written by the handler, lower-cased. */
  headers: Record<string, string | number | string[]>
  /** Body written by the handler. */
  body: string
}

/**
 * Wait for the current macrotask queue to drain, so cordis has applied effects.
 * @param ms - settle window in milliseconds.
 * @returns resolves after the window.
 */
export function tick(ms = 40): Promise<void> {
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
  /** Routes recorded so far, in registration order. */
  routes: TestRoute[] = []

  /**
   * @param ctx - mounting context.
   */
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  /**
   * Record one route.
   * @param route - the route.
   * @returns disposer.
   */
  register(route: TestRoute): () => void {
    this.routes.push(route)
    return () => {
      this.routes = this.routes.filter((entry) => entry !== route)
    }
  }

  /**
   * The recorded route for a path.
   * @param path - exact path.
   * @returns the route.
   */
  route(path: string): TestRoute {
    const found = this.routes.find((entry) => entry.path === path)
    if (found === undefined) {
      throw new Error(`route ${path} is not registered (have: ${this.routes.map((entry) => entry.path).join(', ') || 'none'})`)
    }
    return found
  }
}

/**
 * Build a request for a recorded route.
 * @param method - HTTP method.
 * @param body - JSON body; omitted means an empty request.
 * @param headers - extra headers (host defaults to loopback).
 * @returns a request-shaped readable.
 */
export function makeRequest(method: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))])
  return Object.assign(stream, {
    method,
    headers: {
      host: '127.0.0.1:0',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    url: '/',
  }) as unknown as IncomingMessage
}

/**
 * Build a response that records what a handler wrote.
 * @returns a response-shaped object; `captured` holds status, headers and body.
 */
export function makeResponse(): ServerResponse & { captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' }
  const response = {
    captured,
    get statusCode() {
      return captured.status
    },
    set statusCode(value: number) {
      captured.status = value
    },
    setHeader(name: string, value: string | number | string[]) {
      captured.headers[String(name).toLowerCase()] = value
    },
    end(chunk?: unknown) {
      captured.body = chunk === undefined || chunk === null ? '' : String(chunk)
    },
  }
  return response as unknown as ServerResponse & { captured: CapturedResponse }
}

/**
 * Invoke a recorded route the way the web server would.
 * @param route - the route to call.
 * @param method - HTTP method.
 * @param body - JSON body.
 * @param headers - extra headers.
 * @returns the response as the route wrote it.
 */
export async function callRoute(
  route: TestRoute,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Record<string, string | number | string[]>; json: unknown; body: string }> {
  const response = makeResponse()
  await route.handler(makeRequest(method, body, headers), response)
  const { status, headers: responseHeaders, body: text } = response.captured
  let json: unknown
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
 * @param file - absolute path to the built client bundle.
 * @param id - expected module id, normally the package name.
 * @returns the bundle source.
 */
export function assertClientBundle(file: string, id: string): string {
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
 * @param file - absolute path to the built host entry.
 * @param options - expectations.
 * @param options.name - expected cordis plugin name.
 * @returns the imported module.
 */
export async function assertHostBundle(file: string, { name }: { name?: string } = {}): Promise<Record<string, unknown>> {
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  if (typeof module.apply !== 'function') throw new Error(`${file}: does not export apply`)
  if (name !== undefined && module.name !== name) {
    throw new Error(`${file}: plugin name is ${JSON.stringify(module.name)}, expected ${JSON.stringify(name)}`)
  }
  return module
}

/** The bits of the system-prompt service this toolkit mounts. */
interface SystemPromptContext {
  plugin(plugin: unknown, config?: Record<string, unknown>): unknown
  systemPrompt: {
    assemble(options: unknown): unknown
  }
}

/**
 * Mount the real prompt registry, for tests that need actual assembly.
 *
 * The registry package is imported lazily so plugins that never touch the prompt
 * do not need it installed.
 *
 * @param ctx - context to mount on.
 * @param config - `dsh-system-prompt` configuration.
 * @returns helpers bound to the mount.
 */
export async function mountPromptRegistry(
  ctx: Context,
  config: Record<string, unknown> = {}
): Promise<{ renderPrompt: (...args: never[]) => unknown; assemble: (options: unknown) => unknown }> {
  const { default: SystemPrompt, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const target = ctx as unknown as SystemPromptContext
  target.plugin(SystemPrompt, { includeRuntimeContext: false, ...config })
  await tick()
  return {
    renderPrompt,
    assemble: (options: unknown) => target.systemPrompt.assemble(options),
  }
}
