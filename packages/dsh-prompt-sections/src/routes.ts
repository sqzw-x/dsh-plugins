/**
 * The same-origin HTTP surface the sidebar panel talks to.
 *
 * ## Why routes rather than a client-side settings namespace
 *
 * The editor needs three things a schema-driven form cannot express: the state
 * document as a whole (an ordered list of free-form sections), the assembled
 * prompt for comparison, and immediate save/discard semantics. A tiny JSON API
 * gives that, and keeps the browser half free of any harness-internal client
 * package (it only speaks `fetch`).
 *
 * ## Trust boundary
 *
 * These routes read the prompt and write configuration, so they are guarded
 * rather than open:
 *
 *  - The `Origin` header, when present, must match the request's `Host` — a
 *    cross-site `fetch` cannot reach them.
 *  - Writes must be `application/json`, which a cross-origin form POST cannot
 *    send without a CORS preflight the server never grants.
 *  - Request bodies are bounded; a larger body is rejected instead of buffered.
 *
 * The web server itself binds to loopback by default; if the deployment exposes
 * it on a LAN, the Origin rule still holds for same-origin requests from that
 * address.
 *
 * @module dsh-prompt-sections/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PreviewResult } from './preview.ts'
import type { SectionRegistrar } from './register.ts'
import type { PromptStore, StoreLogger } from './store.ts'
import { StateValidationError, type LayerState } from './types.ts'

/** URL prefix of every route this plugin owns. */
export const ROUTE_PREFIX = '/dsh-prompt-sections'

/** Largest accepted request body (the state document is small; 512 KiB is slack). */
export const MAX_BODY_BYTES: number = 512 * 1024

/** Services the routes need. */
export interface RouteDeps {
  /** The state document. */
  store: PromptStore
  /** Rebuilds the registration plan after a save. */
  registrar: SectionRegistrar
  /** Produces the assembled prompt for the preview. */
  preview(): Promise<PreviewResult>
  /** Logger for rejected requests. */
  logger: StoreLogger
}

/** The state payload the editor reads and writes. */
export interface StatePayload {
  state: LayerState
  path: string
  origin: string
  error?: string
  orderBases: { tailBase: number }
  registered: string[]
}

/** One JSON response envelope. */
type Envelope = { ok: true } & Record<string, unknown>

function sendJson(res: ServerResponse, status: number, payload: Envelope | { ok: false; error: { code: string; message: string } }): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Whether the request's Origin, when sent, is this same origin. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read a bounded JSON body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('request body is too large'), { status: 413, code: 'too-large' })
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request body is too large'), { status: 413, code: 'too-large' })
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { status: 400, code: 'invalid-json' })
  }
}

/** Answer a request this plugin refuses to serve. */
function reject(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** Read the current state as the editor's payload. */
function statePayload(deps: RouteDeps): StatePayload {
  const state = deps.store.current()
  const error = deps.store.lastError()
  return {
    state,
    path: deps.store.displayPath(),
    origin: deps.store.origin(),
    ...error === undefined ? {} : { error },
    orderBases: deps.registrar.orderBases(),
    registered: deps.registrar.registeredNames(),
  }
}

/**
 * Register the three routes on `ctx.webServer` when that service is present.
 *
 * The plugin stays fully functional without it (the host half needs only the
 * prompt registry); a headless profile simply has no editor.
 *
 * @param ctx - the plugin context.
 * @param deps - store, registrar, preview builder and logger.
 */
export function registerRoutes(ctx: Context, deps: RouteDeps): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: async (req, res) => {
          if (!sameOrigin(req)) return reject(res, 403, 'cross-origin', 'cross-origin request refused')
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, ...statePayload(deps) })
            return
          }
          if (req.method !== 'POST') {
            res.setHeader('allow', 'GET, POST')
            return reject(res, 405, 'method-not-allowed', 'use GET or POST')
          }
          const contentType = String(req.headers['content-type'] ?? '')
          if (!contentType.toLowerCase().startsWith('application/json')) {
            return reject(res, 415, 'unsupported-media-type', 'send application/json')
          }
          try {
            const body = await readJsonBody(req)
            const next = deps.store.save(body)
            deps.registrar.sync()
            deps.logger.info(
              `prompt-sections: saved ${next.sections.length} section(s); ${deps.registrar.registeredNames().length} registered`,
            )
            sendJson(res, 200, { ok: true, ...statePayload(deps) })
          } catch (error) {
            if (error instanceof StateValidationError) return reject(res, 422, 'invalid-state', error.message)
            const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500
            const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'write-failed'
            deps.logger.warn(`prompt-sections: save failed (${code}): ${error instanceof Error ? error.message : String(error)}`)
            reject(res, status, code, error instanceof Error ? error.message : String(error))
          }
        },
      }),
      `prompt-sections: ${ROUTE_PREFIX}/state`,
    )

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/preview`,
        handler: async (req, res) => {
          if (!sameOrigin(req)) return reject(res, 403, 'cross-origin', 'cross-origin request refused')
          if (req.method !== 'GET') {
            res.setHeader('allow', 'GET')
            return reject(res, 405, 'method-not-allowed', 'use GET')
          }
          try {
            const preview = await deps.preview()
            sendJson(res, 200, { ok: true, ...preview })
          } catch (error) {
            deps.logger.warn(`prompt-sections: preview failed: ${error instanceof Error ? error.message : String(error)}`)
            reject(res, 500, 'preview-failed', error instanceof Error ? error.message : String(error))
          }
        },
      }),
      `prompt-sections: ${ROUTE_PREFIX}/preview`,
    )
  })
}
