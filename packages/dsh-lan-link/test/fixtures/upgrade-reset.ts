/**
 * Fixture for the reset regression: one paired device opens a WebSocket through
 * the gateway and then vanishes the way a phone does when its screen locks or it
 * moves between Wi-Fi and cellular — a TCP reset, not a close.
 *
 * The gateway must survive that. Node removed its own socket error listener when
 * it handed the socket to 'upgrade', so an unlistened socket turns the reset into
 * an uncaught error event; in the harness host an uncaught exception is fatal,
 * which is how one device dropping off took the whole desktop app down. The
 * failure can only be observed out of process, hence this fixture: it exits 0
 * only when the gateway survived *and* still serves requests afterwards.
 *
 * Run: node test/fixtures/upgrade-reset.ts
 */
import http from 'node:http'
import net from 'node:net'
import { startLanGateway } from '../../lib/gateway.js'

/** Upstream that completes a websocket handshake and then holds the tunnel. */
const upstream = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('ok')
})
upstream.on('upgrade', (request, socket) => {
  socket.on('error', () => {})
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
      'sec-websocket-accept: test\r\n\r\n'
  )
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

const gateway = startLanGateway({
  listenHost: '127.0.0.1',
  listenPort: 0,
  upstreamHost: '127.0.0.1',
  upstreamPort: upstream.address().port,
  log: () => {}
})
const { port } = await gateway.ready

const device = net.connect(port, '127.0.0.1')
await new Promise((resolve, reject) => {
  device.once('data', resolve)
  device.once('error', reject)
  device.on('connect', () => {
    device.write(
      [
        'GET /api/events.mux HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n')
    )
  })
})

// The tunnel is up; now the device disappears without closing it.
device.resetAndDestroy()
await new Promise((resolve) => setTimeout(resolve, 250))

const response = await fetch(`http://127.0.0.1:${String(port)}/`)
if (!response.ok) {
  console.error(`gateway stopped serving after the reset: HTTP ${String(response.status)}`)
  process.exit(1)
}
console.log('gateway survived the reset and still serves')
await gateway.close()
upstream.close()
process.exit(0)
