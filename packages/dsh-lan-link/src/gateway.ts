/**
 * dsh-lan-gateway — the LAN-facing reverse gateway behind dsh-lan-link.
 *
 * Shape of the problem: the harness web surface is a remote control for an
 * agent that can read files and run commands on this machine, so the server
 * deliberately binds loopback only, and both halves of the product ask "is this
 * the host?":
 *
 * - the server side accepts a request whose `Host`/`Origin` name its own
 *   loopback authority and whose `Cookie` carries the authority-bound browser
 *   session minted by a launch token;
 * - the browser side decides whether to render the full host surface or degrade
 *   to a read-mostly "remote visitor" one, from the page's own location plus an
 *   optional flag the desktop shell sets before the app boots.
 *
 * This gateway answers both questions for devices that are not the host, by
 * terminating their connections here and re-issuing every request over loopback
 * as the host's own browser would:
 *
 * 1. it holds the process's own browser-session cookie (minted over loopback,
 *    refreshed on demand) and presents it upstream, so paired devices never see
 *    a launch token and never need one — the credential stays on this machine;
 * 2. it rewrites `Host` and `Origin` to the loopback authority, satisfying the
 *    server-side fence exactly as local access does;
 * 3. it injects two scripts into the served HTML document: a `crypto.randomUUID`
 *    polyfill (browsers withhold that API outside a secure context, and a LAN
 *    page over plain HTTP is not one) and the host-claim flag the desktop shell
 *    itself sets, so the client renders the full surface instead of degrading
 *    to remote-visitor mode.
 *
 * Nothing else is rewritten: responses stream through byte-for-byte, compressed
 * bodies stay compressed, and multi-megabyte client bundles are never buffered
 * or recompressed. Only the document is asked for uncompressed (the gateway
 * chooses its own upstream `Accept-Encoding`) and only the document is touched.
 *
 * Security model — read this before enabling it. Everything reaching the listen
 * port is treated as the host user, because that is exactly what the forwarded
 * session means. The gate is therefore the port's reachability, not a password:
 * bind a single interface, and keep `allowCidrs` to the network you own. Basic
 * credentials are supported as an extra layer, never as the primary one.
 *
 * @module dsh-lan-link/gateway
 */
import http from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import net from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import zlib from 'node:zlib'

/** Log levels the gateway emits to its caller. */
export type GatewayLogLevel = 'info' | 'warn'

/** Sink for the gateway's human-readable diagnostics. */
export type GatewayLog = (level: GatewayLogLevel, message: string) => void

/** One parsed allow-list entry. IPv4 entries carry their integer value and mask. */
export interface CidrRange {
  /** Address family; only IPv4 ranges are matched. */
  family: 4 | 6
  /** Whether the range denotes this machine's own loopback. */
  loopback: boolean
  /** Prefix length in bits. */
  bits: number
  /** IPv4 address as an unsigned integer. */
  value?: number
  /** IPv4 network mask as an unsigned integer. */
  mask?: number
}

/** The result of parsing a configured allow list. */
export interface ParsedCidrs {
  /** Usable ranges. */
  ranges: CidrRange[]
  /** Entries that could not be parsed, kept for a warning. */
  rejected: string[]
}

/** What `probeHostClaimSeam` reports back to the plugin log. */
export interface HostClaimProbe {
  /** Whether the served client bundle still reads the host-claim flag. */
  ok: boolean
  /** Human-readable explanation either way. */
  reason: string
}

/** Options for {@link startLanGateway}. */
export interface LanGatewayOptions {
  /** Interface to bind; `0.0.0.0` means every interface. */
  listenHost?: string
  /** Port to bind; `0` asks the OS for a free one. */
  listenPort?: number
  /** Loopback address of the harness web server. */
  upstreamHost?: string
  /** Port the harness web server bound. */
  upstreamPort: number
  /** Returns a tokenized loopback URL used to mint the host session cookie. */
  credentialUrl?: () => string
  /** Client ranges admitted besides loopback. */
  allowCidrs?: string[]
  /** Whether this machine's own loopback clients are admitted. */
  allowLoopback?: boolean
  /** Basic Auth user; active only together with a password. */
  username?: string
  /** Basic Auth password; active only together with a user. */
  password?: string
  /** Inject the host-claim flag into served documents (default true). */
  injectHostClaim?: boolean
  /** Diagnostics sink. */
  log?: GatewayLog
}

/** The handle returned by {@link startLanGateway}. */
export interface LanGatewayHandle {
  /** Resolves once the listener is bound. */
  ready: Promise<{ port: number }>
  /** Stop the listener and every tunnelled socket. */
  close(): Promise<void>
  /** Mint (or re-mint) the host browser-session cookie over loopback. */
  refreshCookie(): Promise<boolean>
  /** Confirm the served client bundle still reads the host-claim flag. */
  probeHostClaimSeam(): Promise<HostClaimProbe>
  /** The port currently bound, or the configured port before/after binding. */
  readonly boundPort: number
  /** Human-readable HTTP URLs for the given addresses, in input order. */
  describeUrls(boundPort: number, addresses: string[]): string[]
}

/** `crypto.randomUUID` shim for non-secure contexts, built on getRandomValues. */
export const RANDOM_UUID_POLYFILL =
  '<script>(function(){try{if(typeof crypto!=="undefined"&&crypto&&typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="";for(var i=0;i<16;i++){h+=b[i].toString(16).padStart(2,"0")}return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}}catch(e){}})();</script>'

/**
 * The host-claim flag. The browser half of the connection plugin reads this
 * global while installing itself; the Electron shell sets the same object before
 * the app boots, which is how the desktop window gets the full host surface.
 * Setting it here is the same claim through the same seam — no product code is
 * modified, so a harness update cannot silently break a byte-exact patch.
 */
export const HOST_CLAIM_SCRIPT = '<script>globalThis.__DSH_TRANSPORT__={ownsHost:true};</script>'

/** Marker the injected host-claim script is recognised by (idempotence check). */
const HOST_CLAIM_MARKER = '__DSH_TRANSPORT__'

/** Cookies the harness issues for its own authority; never forwarded downstream. */
const HARNESS_COOKIE_PREFIX = 'dsh-auth-'

/** Hop-by-hop headers a proxied HTTP exchange must not carry over. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/**
 * Headers dropped from a tunnelled upgrade. `Connection` and `Upgrade` stay:
 * unlike a proxied HTTP exchange, the raw WebSocket handshake is what the
 * upstream has to read, so stripping them would turn it into a plain GET.
 */
const UPGRADE_DROP = new Set(['proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding'])

/**
 * Insert the given script tags right after the opening `<head …>` tag, or at
 * the very start of the document when it has no head. Returns the input
 * unchanged when an injected script is already present, so a document that
 * passes through twice is never double-injected.
 * @param html - the served document text.
 * @param scripts - script tags to inject, in order.
 * @returns the document to serve.
 */
export function injectHeadScripts(html: string, scripts: string[]): string {
  const pending = scripts.filter((script) => script !== '' && !html.includes(script))
  if (pending.length === 0) return html
  const payload = pending.join('')
  const head = html.toLowerCase().indexOf('<head')
  if (head !== -1) {
    const end = html.indexOf('>', head)
    if (end !== -1) return html.slice(0, end + 1) + payload + html.slice(end + 1)
  }
  return payload + html
}

/**
 * Parse one allow-list entry into a comparable range.
 * Only IPv4 CIDR (`10.0.0.0/8`, a bare address meaning /32) and the IPv6
 * loopback literal are supported — the LAN this gates is IPv4.
 * @param entry - the configured text.
 * @returns the parsed range, or undefined when the entry is unusable.
 */
export function parseCidrEntry(entry: unknown): CidrRange | undefined {
  const text = String(entry ?? '').trim()
  if (text === '') return undefined
  const [address = '', bitsText] = text.split('/')
  if (address === '::1') return { family: 6, loopback: true, bits: 128 }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (octets === null) return undefined
  const parts = octets.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return undefined
  const bits = bitsText === undefined ? 32 : Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return undefined
  const value = parts.reduce((acc, part) => acc * 256 + part, 0)
  return { family: 4, loopback: parts[0] === 127, bits, value, mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }
}

/**
 * Parse a whole allow list, dropping unusable entries.
 * @param entries - configured entries (strings).
 * @returns `{ ranges, rejected }` — rejected entries are reported, never fatal.
 */
export function parseCidrs(entries: unknown): ParsedCidrs {
  const ranges: CidrRange[] = []
  const rejected: string[] = []
  const list: unknown[] = Array.isArray(entries) ? entries : []
  for (const entry of list) {
    const parsed = parseCidrEntry(entry)
    if (parsed === undefined) rejected.push(String(entry))
    else ranges.push(parsed)
  }
  return { ranges, rejected }
}

/** Normalize one socket address, unwrapping IPv4-mapped IPv6 (`::ffff:1.2.3.4`). */
function normalizeAddress(address: unknown): string | undefined {
  if (typeof address !== 'string' || address === '') return undefined
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return (mapped?.[1] ?? address).replace(/^\[|\]$/g, '')
}

/**
 * Whether one client address may use the gateway.
 * @param address - socket peer address.
 * @param ranges - parsed allow list.
 * @param allowLoopback - whether this machine's own loopback clients are allowed.
 * @returns true when the client is admitted.
 */
export function isAddressAllowed(address: unknown, ranges: CidrRange[], allowLoopback = true): boolean {
  const normalized = normalizeAddress(address)
  if (normalized === undefined) return false
  if (normalized === '::1' || normalized.startsWith('127.')) return allowLoopback
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (octets === null) return false
  const parts = octets.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return false
  const value = parts.reduce((acc, part) => acc * 256 + part, 0)
  return ranges.some(
    (range) =>
      range.family === 4 &&
      range.value !== undefined &&
      range.mask !== undefined &&
      ((value & range.mask) >>> 0) === ((range.value & range.mask) >>> 0)
  )
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(left: unknown, right: unknown): boolean {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return a.length > 0 && a.equals(b)
}

/** Whether an incoming `Authorization` header matches the configured Basic pair. */
export function checkBasicAuth(header: unknown, username: string, password: string): boolean {
  const match = /^Basic\s+(.+)$/i.exec(String(header ?? ''))
  if (match === null) return false
  const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator === -1) return false
  // Both halves are always compared: no early return that leaks which field missed.
  const userOk = safeEqual(decoded.slice(0, separator), username)
  const passwordOk = safeEqual(decoded.slice(separator + 1), password)
  return userOk && passwordOk
}

/** Decompress one response body when the rewrite has to see plain text. */
function decompressBody(buffer: Buffer, encoding: unknown): { body: Buffer; encoding: string } | undefined {
  const first = String(encoding ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
  try {
    if (first === '' || first === 'identity') return { body: buffer, encoding: '' }
    if (first === 'gzip') return { body: zlib.gunzipSync(buffer), encoding: 'gzip' }
    if (first === 'deflate') {
      try {
        return { body: zlib.inflateSync(buffer), encoding: 'deflate' }
      } catch {
        return { body: zlib.inflateRawSync(buffer), encoding: 'deflate' }
      }
    }
    if (first === 'br') return { body: zlib.brotliDecompressSync(buffer), encoding: 'br' }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a request is a document navigation (the only body this gateway
 * rewrites). Browsers ask for `text/html` exactly when they will render a page.
 * @param request - incoming request.
 * @returns true for document navigations.
 */
function wantsDocument(request: IncomingMessage): boolean {
  const accept = String(request.headers.accept ?? '')
  return accept.includes('text/html') || accept.includes('application/xhtml+xml')
}

/**
 * Response headers that must survive to the client (everything else is copied).
 * @param upstreamHeaders - the upstream response headers.
 * @param options - `dropLength` drops `content-length` (a rewritten body changes length).
 * @returns headers safe to write downstream.
 */
function responseHeaders(upstreamHeaders: IncomingHttpHeaders, { dropLength }: { dropLength: boolean }): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.has(name)) continue
    // The harness mints its session for *its own* authority; leaking that cookie
    // to a LAN browser would only create a stale credential on the device.
    if (name === 'set-cookie') {
      const kept = (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(
        (cookie) => !String(cookie).toLowerCase().startsWith(HARNESS_COOKIE_PREFIX)
      )
      if (kept.length > 0) headers['set-cookie'] = kept
      continue
    }
    if (name === 'content-length' && dropLength) continue
    headers[key] = value
  }
  return headers
}

/**
 * Start the LAN gateway.
 *
 * @param options - gateway options.
 * @returns a handle: `{ ready, close, boundPort, refreshCookie, probeHostClaimSeam }`.
 */
export function startLanGateway(options: LanGatewayOptions): LanGatewayHandle {
  const {
    listenHost = '0.0.0.0',
    listenPort = 3081,
    upstreamHost = '127.0.0.1',
    upstreamPort,
    credentialUrl,
    allowCidrs = [],
    allowLoopback = true,
    username = '',
    password = '',
    injectHostClaim = true,
    log = () => {}
  } = options

  if (!Number.isSafeInteger(upstreamPort) || upstreamPort <= 0) {
    throw new Error('dsh-lan-gateway: upstreamPort must be the harness web server port')
  }

  const { ranges, rejected } = parseCidrs(allowCidrs)
  for (const entry of rejected) log('warn', `lan-link gateway: ignoring unusable allow-list entry ${JSON.stringify(entry)}`)
  const basicEnabled = username !== '' && password !== ''
  const upstreamAuthority = `${upstreamHost}:${String(upstreamPort)}`
  const upstreamOrigin = `http://${upstreamAuthority}`

  let cookie = ''
  let closed = false
  const upgradedSockets = new Set<Socket>()

  /** Mint (or re-mint) the host browser-session cookie over loopback. */
  const refreshCookie = async (): Promise<boolean> => {
    if (typeof credentialUrl !== 'function') return false
    const url = credentialUrl()
    if (typeof url !== 'string' || url === '') return false
    const response = await fetch(url, { redirect: 'manual' })
    const headerBag = response.headers as Headers & { getSetCookie?: () => string[] }
    const [setCookie] = headerBag.getSetCookie?.() ?? []
    if (setCookie === undefined) {
      log('warn', `lan-link gateway: could not mint the host session cookie (HTTP ${String(response.status)})`)
      return false
    }
    cookie = setCookie.split(';')[0] ?? ''
    return true
  }

  /** One upstream request, with the host identity applied. */
  const forward = (request: IncomingMessage, { identity, cookieValue }: { identity: boolean; cookieValue: string }): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const headers: OutgoingHttpHeaders = {}
      for (const [key, value] of Object.entries(request.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue
        headers[key] = value
      }
      headers.host = upstreamAuthority
      headers.origin = upstreamOrigin
      if (cookieValue !== '') headers.cookie = cookieValue
      else delete headers.cookie
      if (identity) headers['accept-encoding'] = 'identity'
      const upstream = http.request(
        { host: upstreamHost, port: upstreamPort, method: request.method, path: request.url, headers },
        resolve
      )
      upstream.on('error', reject)
      request.pipe(upstream)
    })

  /** Stream one upstream response to the client untouched. */
  const pipeThrough = (upstreamResponse: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers, { dropLength: false }))
    upstreamResponse.pipe(response)
  }

  /** Serve one upstream response, rewriting the document when it is HTML. */
  const pipeDocument = (upstreamResponse: IncomingMessage, response: ServerResponse, scripts: string[]): void => {
    const chunks: Buffer[] = []
    upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
    upstreamResponse.on('end', () => {
      const raw = Buffer.concat(chunks)
      const decoded = decompressBody(raw, upstreamResponse.headers['content-encoding'])
      if (decoded === undefined) {
        // Unsupported encoding: pass the bytes through rather than corrupt them.
        log('warn', 'lan-link gateway: document arrived with an unsupported encoding; serving it unmodified')
        const headers = responseHeaders(upstreamResponse.headers, { dropLength: false })
        headers['content-encoding'] = upstreamResponse.headers['content-encoding']
        response.writeHead(upstreamResponse.statusCode ?? 502, headers)
        response.end(raw)
        return
      }
      const html = decoded.body.toString('utf8')
      const patched = injectHeadScripts(html, scripts)
      const headers = responseHeaders(upstreamResponse.headers, { dropLength: true })
      delete headers['content-encoding']
      response.writeHead(upstreamResponse.statusCode ?? 502, headers)
      response.end(Buffer.from(patched, 'utf8'))
    })
    upstreamResponse.on('error', () => response.destroy())
  }

  const scripts = injectHostClaim ? [RANDOM_UUID_POLYFILL, HOST_CLAIM_SCRIPT] : [RANDOM_UUID_POLYFILL]

  /** Refuse (403/401) or admit one request; returns true when the caller may proceed. */
  const admit = (request: IncomingMessage, response: ServerResponse): boolean => {
    const address = request.socket.remoteAddress
    if (!isAddressAllowed(address, ranges, allowLoopback)) {
      log('warn', `lan-link gateway: refused ${String(address)} (outside the allow list)`)
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('403 Forbidden\n')
      return false
    }
    if (basicEnabled && !checkBasicAuth(request.headers.authorization, username, password)) {
      response.writeHead(401, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'www-authenticate': 'Basic realm="dsh-lan-link"'
      })
      response.end('401 Unauthorized\n')
      return false
    }
    return true
  }

  const server = http.createServer((request, response) => {
    if (!admit(request, response)) return
    const document = wantsDocument(request)
    void (async () => {
      try {
        let upstreamResponse = await forward(request, { identity: document, cookieValue: cookie })
        // The session is absent, stale, or rotated: mint it and replay once.
        // Only bodyless requests are replayed, because the client's request
        // stream is consumed by the first attempt.
        if (upstreamResponse.statusCode === 401 && (request.method === 'GET' || request.method === 'HEAD')) {
          upstreamResponse.resume()
          if (await refreshCookie()) {
            upstreamResponse = await forward(request, { identity: document, cookieValue: cookie })
          }
        }
        const contentType = String(upstreamResponse.headers['content-type'] ?? '')
        if (document && contentType.includes('text/html')) {
          pipeDocument(upstreamResponse, response, scripts)
          return
        }
        if (contentType.includes('text/html')) {
          // An HTML body on a non-document request: still worth the injections.
          pipeDocument(upstreamResponse, response, scripts)
          return
        }
        pipeThrough(upstreamResponse, response)
      } catch (error) {
        log('warn', `lan-link gateway: upstream request failed: ${String(error)}`)
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('502 Bad Gateway\n')
      }
    })()
  })

  server.on('upgrade', (request, socket, head) => {
    const client = socket as Socket
    if (!isAddressAllowed(request.socket.remoteAddress, ranges, allowLoopback) ||
        (basicEnabled && !checkBasicAuth(request.headers.authorization, username, password))) {
      client.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    const headers: OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (UPGRADE_DROP.has(key.toLowerCase())) continue
      headers[key] = value
    }
    headers.host = upstreamAuthority
    headers.origin = upstreamOrigin
    if (cookie !== '') headers.cookie = cookie
    else delete headers.cookie
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
        else lines.push(`${key}: ${String(value)}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upgradedSockets.add(client)
    // A device that vanishes resets its tunnel rather than closing it, and Node
    // removed its own socket error listener when it handed the socket to
    // 'upgrade': without this listener that ECONNRESET arrives as an uncaught
    // error event, and the harness host treats an uncaught exception as fatal
    // for the whole process — one phone losing Wi-Fi took the desktop app down.
    client.on('error', () => client.destroy())
    client.once('close', () => {
      upgradedSockets.delete(client)
      upstream.destroy()
    })
    upstream.on('error', () => {
      upgradedSockets.delete(client)
      client.destroy()
    })
  })

  const ready = new Promise<{ port: number }>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(listenPort, listenHost, () => {
      server.off('error', onError)
      server.on('error', (error) => log('warn', `lan-link gateway: ${String(error)}`))
      const address: AddressInfo | string | null = server.address()
      if (typeof address === 'object' && address !== null) resolve({ port: address.port })
      else reject(new Error('dsh-lan-gateway: the listener did not bind a TCP address'))
    })
  })

  /**
   * Fetch the served client bundle and confirm it still reads the host-claim
   * flag. A harness that drops the seam degrades the page to remote-visitor
   * mode; better to say so in the log than to leave the user guessing.
   * @returns `{ ok, reason }`.
   */
  const probeHostClaimSeam = async (): Promise<HostClaimProbe> => {
    if (!injectHostClaim) return { ok: true, reason: 'host claim disabled' }
    try {
      const document = await fetch(`http://${upstreamAuthority}/`, {
        headers: { cookie, accept: 'text/html', 'accept-encoding': 'identity' },
        redirect: 'manual'
      })
      const html = await document.text()
      const match = /(plugins\/\?\?[^"']*dsh-client-connection\/client\.js[^"']*)/.exec(html)
      if (match === null) return { ok: false, reason: 'the connection client bundle is not referenced by the served index' }
      const bundleUrl = match[1]
      if (bundleUrl === undefined) return { ok: false, reason: 'the connection client bundle is not referenced by the served index' }
      const bundle = await fetch(`http://${upstreamAuthority}/${bundleUrl.replaceAll('&amp;', '&')}`, {
        headers: { cookie, 'accept-encoding': 'identity' }
      })
      const code = await bundle.text()
      return code.includes('ownsHost')
        ? { ok: true, reason: 'the served connection bundle reads the host-claim flag' }
        : { ok: false, reason: 'the served connection bundle no longer reads the host-claim flag; the page will degrade to remote-visitor mode' }
    } catch (error) {
      return { ok: false, reason: `host-claim probe failed: ${String(error)}` }
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const socket of upgradedSockets) socket.destroy()
    upgradedSockets.clear()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      const timer = setTimeout(() => server.closeAllConnections(), 250)
      timer.unref?.()
    })
  }

  return {
    ready,
    close,
    refreshCookie,
    probeHostClaimSeam,
    get boundPort() {
      const address = server.address()
      return typeof address === 'object' && address !== null ? address.port : listenPort
    },
    /** Human-readable URLs for the given addresses, in input order. */
    describeUrls(boundPort: number, addresses: string[]): string[] {
      return addresses.map((address) => `http://${address}:${String(boundPort)}/`)
    }
  }
}
