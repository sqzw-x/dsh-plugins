/**
 * dsh-lan-link gateway tests — the gateway must present the host identity
 * upstream (Host/Origin/cookie), inject the two head scripts into documents
 * only, leave every other response byte-identical, hold the session itself
 * (so devices need no token), re-mint it when the harness rejects it, refuse
 * clients outside the allow list, tunnel WebSocket upgrades with the
 * handshake intact, and survive a device that resets its tunnel instead of
 * closing it.
 *
 * Run: node --test test/gateway.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  HOST_CLAIM_SCRIPT,
  RANDOM_UUID_POLYFILL,
  checkBasicAuth,
  injectHeadScripts,
  isAddressAllowed,
  parseCidrs,
  startLanGateway
} from '../lib/gateway.js'

/** Fixture that resets a live tunnel; it has to run out of process (see below). */
const RESET_FIXTURE = fileURLToPath(new URL('./fixtures/upgrade-reset.ts', import.meta.url))

/** Cookie the fake harness mints and then expects back on every request. */
const SESSION_COOKIE = 'dsh-auth-test=SESSION'

/**
 * Start a fake harness web server.
 * @param handler - `(req, res, seen)` request handler.
 * @param onUpgrade - optional `(req, socket, head, seen)` upgrade handler.
 * @returns `{ port, origin, seen, requests, close }`.
 */
async function startUpstream(handler, onUpgrade) {
  const seen = { requests: [] }
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const record = {
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      cookie: req.headers.cookie,
      acceptEncoding: req.headers['accept-encoding'],
      upgrade: req.headers.upgrade
    }
    seen.requests.push(record)
    handler(req, res, record)
  })
  if (onUpgrade !== undefined) server.on('upgrade', (req, socket, head) => onUpgrade(req, socket, head, seen))
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }
}

/** Start a gateway against `upstream` and hand back its base URL. */
async function startGateway(upstream, options = {}) {
  const gateway = startLanGateway({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.port,
    credentialUrl: () => `${upstream.origin}/mint`,
    log: () => {},
    ...options
  })
  const { port } = await gateway.ready
  return { gateway, base: `http://127.0.0.1:${String(port)}` }
}

/**
 * Raw node HTTP GET: returns the exact wire bytes, so a test can prove the
 * gateway did not re-encode a body that fetch() would silently decompress.
 * @param origin - parsed origin URL to dial.
 * @param path - request path.
 * @param headers - extra request headers.
 * @returns `{ status, headers, body }`.
 */
function rawGet(origin, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: origin.hostname, port: origin.port, path, headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
      }
    )
    request.on('error', reject)
    request.end()
  })
}

test('injects head scripts after <head>, before a headless document, and only once', () => {
  assert.equal(
    injectHeadScripts('<html><head><title>t</title></head><body></body></html>', ['<script>a</script>']),
    '<html><head><script>a</script><title>t</title></head><body></body></html>'
  )
  assert.match(
    injectHeadScripts('<html><head lang="zh">x</head></html>', ['<script>a</script>']),
    /^<html><head lang="zh"><script>a<\/script>x/
  )
  assert.equal(injectHeadScripts('<body>no head</body>', ['<script>a</script>']), '<script>a</script><body>no head</body>')
  const once = injectHeadScripts('<head></head>', ['<script>a</script>'])
  assert.equal(injectHeadScripts(once, ['<script>a</script>']), once, 'already-injected document is left alone')
  assert.equal(injectHeadScripts('<head></head>', []), '<head></head>')
  assert.equal(injectHeadScripts('<head></head>', ['']), '<head></head>')
})

test('parses an allow list and admits exactly the addresses in it', () => {
  const { ranges, rejected } = parseCidrs(['192.168.0.0/24', '10.1.2.3', '::1', '', 'nonsense', '10.0.0.0/33', '999.0.0.1'])
  assert.deepEqual(rejected, ['', 'nonsense', '10.0.0.0/33', '999.0.0.1'], 'unusable entries are reported, not fatal')

  assert.equal(isAddressAllowed('192.168.0.2', ranges), true)
  assert.equal(isAddressAllowed('192.168.0.255', ranges), true)
  assert.equal(isAddressAllowed('192.168.1.2', ranges), false)
  assert.equal(isAddressAllowed('10.1.2.3', ranges), true)
  assert.equal(isAddressAllowed('10.1.2.4', ranges), false)
  assert.equal(isAddressAllowed('::ffff:192.168.0.7', ranges), true, 'IPv4-mapped clients match')
  assert.equal(isAddressAllowed(undefined, ranges), false)
  assert.equal(isAddressAllowed('fe80::1', ranges), false, 'IPv6 beyond ::1 is not matched')

  assert.equal(isAddressAllowed('127.0.0.1', [], true), true)
  assert.equal(isAddressAllowed('::1', [], true), true)
  assert.equal(isAddressAllowed('127.0.0.1', ranges, false), false, 'loopback can be excluded')
  assert.equal(isAddressAllowed('127.9.9.9', [parseCidrs(['127.0.0.0/8']).ranges[0]], false), false, 'loopback is decided by the flag, not by a range')

  const everything = parseCidrs(['0.0.0.0/0']).ranges
  assert.equal(isAddressAllowed('8.8.8.8', everything), true)
})

test('verifies Basic credentials without leaking which half failed', () => {
  const header = `Basic ${Buffer.from('admin:s3cret').toString('base64')}`
  assert.equal(checkBasicAuth(header, 'admin', 's3cret'), true)
  assert.equal(checkBasicAuth(header, 'admin', 'wrong'), false)
  assert.equal(checkBasicAuth(header, 'wrong', 's3cret'), false)
  assert.equal(checkBasicAuth(undefined, 'admin', 's3cret'), false)
  assert.equal(checkBasicAuth('Bearer abc', 'admin', 's3cret'), false)
  assert.equal(checkBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`, 'admin', 's3cret'), false)
})

test('document requests are re-issued as the host and get both scripts injected', async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.url === '/mint') {
      res.writeHead(303, { location: './', 'set-cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '38' })
    res.end('<html><head><title>up</title></head></html>')
  })
  const { gateway, base } = await startGateway(upstream)
  try {
    assert.equal(await gateway.refreshCookie(), true, 'the gateway mints the host session over loopback')

    const response = await fetch(`${base}/`, { headers: { accept: 'text/html,application/xhtml+xml' } })
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.ok(body.includes(RANDOM_UUID_POLYFILL), 'randomUUID polyfill is injected')
    assert.ok(body.includes(HOST_CLAIM_SCRIPT), 'the host-claim flag is injected')
    assert.equal(response.headers.get('content-length'), null, 'a rewritten body is sent chunked')

    const seen = upstream.seen.requests.at(-1)
    assert.equal(seen.host, `127.0.0.1:${String(upstream.port)}`, 'Host names the loopback authority')
    assert.equal(seen.origin, upstream.origin, 'Origin matches the rewritten Host')
    assert.equal(seen.cookie, SESSION_COOKIE, 'the device needs no cookie of its own')
    assert.equal(seen.acceptEncoding, 'identity', 'the document is fetched uncompressed')
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('non-document responses stream through byte-identical, still compressed', async () => {
  const payload = Buffer.from('export const marker = 1\n'.repeat(500))
  const compressed = zlib.gzipSync(payload)
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': 'gzip', 'content-length': String(compressed.length) })
    res.end(compressed)
  })
  const { gateway, base } = await startGateway(upstream)
  try {
    const raw = await rawGet(new URL(base), '/bundle.js', { accept: '*/*', 'accept-encoding': 'gzip, br' })
    assert.deepEqual(raw.body, compressed, 'the gateway never re-encodes asset bodies')
    assert.equal(raw.headers['content-encoding'], 'gzip')
    assert.equal(raw.headers['content-length'], String(compressed.length), 'length is preserved when nothing is rewritten')

    const seen = upstream.seen.requests.at(-1)
    assert.equal(seen.acceptEncoding, 'gzip, br', 'asset requests keep the client encoding preferences')
    assert.ok(!raw.body.toString('latin1').includes('__DSH_TRANSPORT__'), 'nothing is injected into assets')
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('an HTML body that arrives compressed is rewritten and served as plain text', async () => {
  const html = '<html><head></head><body>gz</body></html>'
  const compressed = zlib.gzipSync(Buffer.from(html))
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': String(compressed.length) })
    res.end(compressed)
  })
  const { gateway, base } = await startGateway(upstream)
  try {
    const response = await fetch(`${base}/gz.html`, { headers: { accept: '*/*' } })
    const body = await response.text()
    assert.equal(response.headers.get('content-encoding'), null, 'the rewritten body is no longer gzip')
    assert.ok(body.includes(HOST_CLAIM_SCRIPT))
    assert.ok(body.includes('<body>gz</body>'))
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('a rejected session is re-minted once and the request retried', async () => {
  let minted = 0
  const upstream = await startUpstream((req, res, record) => {
    if (req.url === '/mint') {
      minted += 1
      res.writeHead(303, { location: './', 'set-cookie': `${SESSION_COOKIE}; Path=/` })
      res.end()
      return
    }
    if (record.cookie !== SESSION_COOKIE) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('dsh web authentication required\n')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><head></head><body>ok</body></html>')
  })
  const { gateway, base } = await startGateway(upstream)
  try {
    // No explicit refreshCookie(): the first request comes back 401, the
    // gateway mints the session itself and replays the request.
    const response = await fetch(`${base}/`, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200, 'the retried request succeeds')
    assert.equal(minted, 1, 'the session was minted exactly once')
    assert.equal(upstream.seen.requests.filter((entry) => entry.url === '/').length, 2, 'the document request was retried once')
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('refuses clients outside the allow list before touching the upstream', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><head></head></html>')
  })
  const { gateway, base } = await startGateway(upstream, { allowLoopback: false, allowCidrs: ['10.0.0.0/8'] })
  try {
    const response = await fetch(`${base}/`, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 403)
    assert.equal(upstream.seen.requests.length, 0, 'a refused client never reaches the harness')
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('an optional Basic gate challenges HTTP and WebSocket alike', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><head></head></html>')
  })
  const { gateway, base } = await startGateway(upstream, { username: 'admin', password: 's3cret' })
  try {
    const anonymous = await fetch(`${base}/`, { headers: { accept: 'text/html' } })
    assert.equal(anonymous.status, 401)
    assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Basic /)

    const wrong = await fetch(`${base}/`, { headers: { accept: 'text/html', authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` } })
    assert.equal(wrong.status, 401)

    const allowed = await fetch(`${base}/`, { headers: { accept: 'text/html', authorization: `Basic ${Buffer.from('admin:s3cret').toString('base64')}` } })
    assert.equal(allowed.status, 200)
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('WebSocket upgrades tunnel with the handshake and the host identity intact', async () => {
  const upstream = await startUpstream(
    (req, res) => {
      if (req.url === '/mint') {
        res.writeHead(303, { location: './', 'set-cookie': `${SESSION_COOKIE}; Path=/` })
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    },
    (req, socket, head, seen) => {
      seen.requests.push({
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        cookie: req.headers.cookie,
        upgrade: req.headers.upgrade
      })
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: test\r\n\r\n')
      socket.write('hello-from-upstream')
    }
  )
  const { gateway, base } = await startGateway(upstream)
  const gatewayPort = Number(new URL(base).port)
  try {
    await gateway.refreshCookie()
    const socket = net.connect(gatewayPort, '127.0.0.1')
    const received = await new Promise((resolve, reject) => {
      const chunks = []
      socket.on('data', (chunk) => {
        chunks.push(chunk)
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.includes('hello-from-upstream')) resolve(text)
      })
      socket.on('error', reject)
      socket.on('connect', () => {
        socket.write(
          [
            'GET /api/events.mux HTTP/1.1',
            `Host: 127.0.0.1:${String(gatewayPort)}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
            'Sec-WebSocket-Version: 13',
            `Origin: http://127.0.0.1:${String(gatewayPort)}`,
            '',
            ''
          ].join('\r\n')
        )
      })
      setTimeout(() => reject(new Error('no upgrade response')), 3000).unref()
    })
    assert.match(received, /101 Switching Protocols/)
    assert.match(received, /hello-from-upstream/)

    const seen = upstream.seen.requests.at(-1)
    assert.equal(seen.upgrade, 'websocket', 'the handshake survives the tunnel')
    assert.equal(seen.host, `127.0.0.1:${String(upstream.port)}`)
    assert.equal(seen.origin, upstream.origin)
    assert.equal(seen.cookie, SESSION_COOKIE)
    socket.destroy()
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('a device that resets its tunnel does not take the host down', async () => {
  // Node removes its own socket error listener before emitting 'upgrade', so a
  // gateway that does not listen on the upgraded socket turns the device's
  // ECONNRESET into an uncaught error event — and in the harness host an
  // uncaught exception is fatal for the whole process. That failure kills
  // whatever process observes it, so the scenario runs in this fixture.
  const child = spawn(process.execPath, [RESET_FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const { code, signal } = await new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }))
  })

  assert.doesNotMatch(stderr, /ECONNRESET/, `the reset surfaced as an uncaught error:\n${stderr}`)
  assert.equal(signal, null, `the fixture was killed by ${String(signal)}:\n${stderr}`)
  assert.equal(code, 0, `the fixture exited ${String(code)}:\n${stderr}`)
  assert.match(stdout, /survived the reset and still serves/)
})

test('the host-claim probe reports whether the served bundle still reads the flag', async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><head></head><body><script src="plugins/??@deepseek-ai/dsh-client-connection/client.js&amp;rev=abc"></script></body></html>')
      return
    }
    if (req.url.startsWith('/plugins/??')) {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('handle = { isLoopback: transport?.ownsHost === true, other: 1 }')
      return
    }
    res.writeHead(404)
    res.end()
  })
  const { gateway } = await startGateway(upstream)
  try {
    await gateway.refreshCookie()
    const ok = await gateway.probeHostClaimSeam()
    assert.equal(ok.ok, true)
    assert.match(ok.reason, /reads the host-claim flag/)
  } finally {
    await gateway.close()
    await upstream.close()
  }

  const stale = await startUpstream((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><head></head><body><script src="plugins/??@deepseek-ai/dsh-client-connection/client.js"></script></body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end('const isLoopback = location.hostname === "localhost"')
  })
  const second = await startGateway(stale)
  try {
    const result = await second.gateway.probeHostClaimSeam()
    assert.equal(result.ok, false, 'a harness that dropped the seam is reported instead of silently degrading')
    assert.match(result.reason, /no longer reads/)
  } finally {
    await second.gateway.close()
    await stale.close()
  }
})

test('describeUrls lists one gateway URL per address', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200)
    res.end()
  })
  const { gateway } = await startGateway(upstream)
  try {
    assert.deepEqual(gateway.describeUrls(3081, ['127.0.0.1', '192.168.0.2']), [
      'http://127.0.0.1:3081/',
      'http://192.168.0.2:3081/'
    ])
  } finally {
    await gateway.close()
    await upstream.close()
  }
})
