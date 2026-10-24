/**
 * Live smoke test for the dsh-lan-link gateway: run the gateway against the
 * harness process that is serving this machine right now, and assert what a
 * device on the LAN would actually get.
 *
 * The script starts nothing but the gateway itself (it does not install the
 * plugin), so it is safe to run at any time; it binds the requested port for a
 * few seconds and releases it afterwards. It needs a live harness and its
 * launch token, which it reads from <harness home>/lan-link.txt — the file this
 * package's publisher writes.
 *
 * Usage:
 *   node scripts/live-smoke.mjs
 *   node scripts/live-smoke.mjs --host 192.168.0.2 --port 3081
 *   node scripts/live-smoke.mjs --harness-port 50908 --token <launch token>
 */
import { readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { startLanGateway } from '../lib/gateway.js'

/** Parse `--key value` / `--key=value` into a plain object. */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [key, inline] = token.slice(2).split('=')
    out[key] = inline ?? argv[++index]
  }
  return out
}

/** The harness home, honouring a DSH_HOME override like the harness does. */
function harnessHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** First non-internal IPv4 address, i.e. the machine's LAN face. */
function firstLanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal === false) return entry.address
    }
  }
  return '127.0.0.1'
}

const args = parseArgs(process.argv.slice(2))
const linkFile = join(harnessHome(), args.file ?? 'lan-link.txt')
const linkText = (() => {
  try {
    return readFileSync(linkFile, 'utf8')
  } catch {
    return ''
  }
})()

const host = args.host ?? firstLanAddress()
const listenPort = Number(args.port ?? 3081)
const harnessPort = Number(args['harness-port'] ?? /harness port (\d+)/.exec(linkText)?.[1] ?? 3080)
const token = args.token ?? /[?&]token=([A-Za-z0-9_-]+)/.exec(linkText)?.[1]
const allowCidrs = args['allow-cidrs'] !== undefined ? String(args['allow-cidrs']).split(',') : [`${host.split('.').slice(0, 3).join('.')}.0/24`]

if (token === undefined) {
  console.error(`no launch token: pass --token, or let ${linkFile} exist (written by this plugin's publisher)`)
  process.exit(2)
}

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log(`gateway smoke: ${host}:${listenPort} -> 127.0.0.1:${harnessPort} (allow ${allowCidrs.join(', ')})`)
const gateway = startLanGateway({
  listenHost: host,
  listenPort,
  upstreamHost: '127.0.0.1',
  upstreamPort: harnessPort,
  credentialUrl: () => `http://127.0.0.1:${String(harnessPort)}/?token=${token}`,
  allowCidrs,
  log: (level, message) => console.log(`      [${level}] ${message}`)
})
const { port } = await gateway.ready
const base = `http://${host}:${String(port)}`

try {
  check('session minted over loopback', await gateway.refreshCookie())

  const index = await fetch(`${base}/`, { headers: { accept: 'text/html' } })
  const html = await index.text()
  check('anonymous LAN request needs no token', index.status === 200, `HTTP ${String(index.status)}`)
  check('host-claim flag injected', html.includes('__DSH_TRANSPORT__={ownsHost:true}'))
  check('randomUUID polyfill injected', html.includes('crypto.randomUUID=function'))

  const bundlePath = /(plugins\/\?\?[^"']*dsh-client-connection\/client\.js[^"']*)/.exec(html)?.[1]?.replaceAll('&amp;', '&')
  if (bundlePath === undefined) {
    check('client bundle referenced by the index', false)
  } else {
    const [viaGateway, direct] = await Promise.all([
      fetch(`${base}/${bundlePath}`).then((response) => response.arrayBuffer()),
      fetch(`http://127.0.0.1:${String(harnessPort)}/${bundlePath}`).then((response) => response.arrayBuffer())
    ])
    const bytes = Buffer.from(viaGateway)
    check('client bundle served byte-identical (no JS rewriting)', Buffer.compare(bytes, Buffer.from(direct)) === 0, `${String(bytes.length)} bytes`)
    check('bundle still carries the untouched host-claim seam', bytes.includes('isLoopback: transport?.ownsHost === true'))
  }

  const seam = await gateway.probeHostClaimSeam()
  check('host-claim seam probe', seam.ok, seam.reason)

  const upgrade = await new Promise((resolve) => {
    const socket = net.connect(port, host)
    const chunks = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.includes('\r\n\r\n')) resolve(text.split('\r\n')[0])
    })
    socket.on('error', (error) => resolve(`error: ${error.message}`))
    socket.on('connect', () => {
      socket.write(
        [
          'GET /api/remote.mux HTTP/1.1',
          `Host: ${host}:${String(port)}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          `Origin: http://${host}:${String(port)}`,
          '',
          ''
        ].join('\r\n')
      )
    })
    setTimeout(() => resolve('timeout'), 5000).unref?.()
  })
  check('WebSocket stream upgrade tunnelled', upgrade.startsWith('HTTP/1.1 101'), upgrade)
  check('a second document request reuses the session', (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).status === 200)
} finally {
  await gateway.close()
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
