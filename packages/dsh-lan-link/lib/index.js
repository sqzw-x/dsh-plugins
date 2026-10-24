/**
 * dsh-lan-link — publish this harness process's authenticated LAN access for
 * phones and other devices, and (optionally) serve that access locally.
 *
 * The harness mints one random launch token per process and prints it exactly
 * once, at startup, as `dsh web: http://<host>:<port>/?token=…`. That root
 * exchange is the only way to obtain the authority-bound browser-session cookie
 * every `/api` call and WebSocket upgrade needs, and the token is never
 * persisted. The packaged Desktop app pipes the line to its own stdout, which
 * macOS points at /dev/null for a Finder-launched bundle — so on the Desktop
 * app the link is effectively unobservable, and a phone pointed at its LAN
 * address has no way to sign in.
 *
 * A host plugin runs inside the same process as the Connection service, so it
 * can simply ask for the authenticated URL of any authority — including the
 * machine's own LAN addresses. This plugin waits until the web server has bound,
 * writes one link per address to `<harness home>/lan-link.txt` (mode 0600), and
 * registers `DSH_LAN_LINK` in the shell environment so later commands can read
 * it back.
 *
 * Publishing links only helps a device that can reach the harness listener. On
 * the Desktop app it cannot: the listener is loopback-only by design, and the
 * app itself needs it there. Enabling `gateway` adds a second listener on this
 * machine's network address that terminates device connections and re-issues
 * them over loopback as the host's own browser would — including the host's
 * session cookie, so a device needs no token at all. `lib/gateway.js` documents
 * that trade in full; read it before turning the option on, because everything
 * that reaches that port is treated as this machine's user.
 *
 * The written file is a credential either way: a token link mints a session
 * that reaches the whole tool-capable API, and a gateway link needs no token
 * because it carries the same power already. There is no per-device revocation
 * on the host — revoking means deleting the `client-connection/browser-session`
 * record in `.credentials.yaml` and restarting. Treat the file accordingly, and
 * delete it when it is not needed.
 *
 * @module dsh-lan-link
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { startLanGateway } from './gateway.js'

/** Stable Cordis plugin name. */
export const name = 'lan-link'

/** Exported so a deployment can start the gateway directly (tests, scripts). */
export { startLanGateway }

/** Default target file name, under the harness home. */
const DEFAULT_FILE_NAME = 'lan-link.txt'

/** How often the bound port and the address set are re-checked, in ms. */
const DEFAULT_INTERVAL_MS = 1000

/** Default gateway listen port when the option is enabled without one. */
const DEFAULT_GATEWAY_PORT = 3081

/** Shortest gap between two gateway start attempts after a failure, in ms. */
const GATEWAY_RETRY_MS = 10_000

/** Explanatory header, written verbatim at the top of every revision. */
const HEADER = [
  '# dsh-lan-link — authenticated LAN access for this harness process.',
  '# Gateway links need no token: the gateway holds this process\'s browser',
  '# session and presents it for the device. Token links sign one device in for',
  '# 30 days and only work where the harness listener itself is reachable.',
  '# Either kind grants the same access as a shell on this machine, and the host',
  '# cannot revoke a single device. Delete this file when it is not needed.',
  ''
].join('\n')

/**
 * Resolve the harness home the way the rest of the harness does, so a
 * `DSH_HOME` override lands the file beside the profile that produced it.
 * @returns absolute harness home directory.
 */
function harnessHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Every non-internal IPv4 address of this machine, with the interface that
 * carries it, so the reader can tell Wi-Fi from a VPN or a proxy tunnel.
 * @returns entries sorted by address, one per address.
 */
function lanCandidates() {
  const byAddress = new Map()
  for (const [iface, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal !== false) continue
      if (!byAddress.has(entry.address)) byAddress.set(entry.address, iface)
    }
  }
  return [...byAddress.entries()]
    .map(([address, iface]) => ({ address, iface }))
    .sort((left, right) => left.address.localeCompare(right.address))
}

/**
 * Read the optional gateway block. Absent or `enabled: false` keeps the
 * publisher-only behaviour this plugin shipped with.
 * @param raw - the `gateway` config object, if any.
 * @returns normalized gateway options, or undefined when disabled.
 */
function readGatewayConfig(raw) {
  if (raw === null || typeof raw !== 'object' || raw.enabled !== true) return undefined
  // 0 is meaningful here: the OS picks a free port (tests, or a deployment
  // that publishes the bound port rather than fixing one).
  const listenPort = Number.isSafeInteger(raw.listenPort) && raw.listenPort >= 0 && raw.listenPort <= 65535
    ? raw.listenPort
    : DEFAULT_GATEWAY_PORT
  return {
    listenHost: typeof raw.listenHost === 'string' && raw.listenHost !== '' ? raw.listenHost : '0.0.0.0',
    listenPort,
    allowCidrs: Array.isArray(raw.allowCidrs) ? raw.allowCidrs.filter((entry) => typeof entry === 'string') : [],
    allowLoopback: raw.allowLoopback !== false,
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : '',
    injectHostClaim: raw.injectHostClaim !== false,
    verifySeam: raw.verifySeam !== false
  }
}

function readConfig(config) {
  const rawName = typeof config?.fileName === 'string' && config.fileName !== '' ? config.fileName : DEFAULT_FILE_NAME
  const fileName = isAbsolute(rawName) ? rawName : join(harnessHome(), rawName)
  const intervalMs = Number.isSafeInteger(config?.intervalMs) && config.intervalMs > 0 ? config.intervalMs : DEFAULT_INTERVAL_MS
  return { fileName, intervalMs, gateway: readGatewayConfig(config?.gateway) }
}

/**
 * Mount the publisher (and the optional gateway). Deliberately declares no
 * `inject`: the row activates immediately and finds its services lazily, so a
 * missing optional service can never leave this entry pending or failed and take
 * the browser boot with it.
 * @param ctx - plugin context.
 * @param config - optional `{ fileName, intervalMs, gateway }`.
 */
export function apply(ctx, config) {
  const { fileName, intervalMs, gateway: gatewayConfig } = readConfig(config)
  const directory = dirname(fileName)
  let lastKey
  let shellRegistered = false
  let lastLanUrl = ''

  let gateway
  let gatewayBoundPort
  let gatewayUpstreamPort
  let gatewayStarting = false
  let gatewayFailedAt = 0
  // Status lines are published into the file: on the packaged Desktop app the
  // plugin's log output goes to a stdout nobody reads, so the file is the only
  // place a human can see whether the gateway and its self-checks are healthy.
  let gatewayStatus = []

  const warn = (message) => {
    try {
      if (ctx.logger?.warn !== undefined) ctx.logger.warn(message)
      else console.error(message)
    } catch {
      /* a plugin must never fail because logging failed */
    }
  }
  const note = (message) => {
    try {
      if (ctx.logger?.info !== undefined) ctx.logger.info(message)
    } catch {
      /* ignore */
    }
  }

  /** Register `DSH_LAN_LINK` once, after the first link is known. */
  const registerShellVariable = () => {
    if (shellRegistered) return
    try {
      const shellEnv = ctx.get?.('shellEnv')
      if (shellEnv?.register === undefined) return
      shellEnv.register({
        name: 'lan-link',
        variables: {
          DSH_LAN_LINK: {
            description: 'Authenticated LAN access for this harness process; open it on a device to sign in.'
          }
        },
        resolve: () => ({ DSH_LAN_LINK: lastLanUrl })
      })
      shellRegistered = true
    } catch (error) {
      warn(`lan-link: shellEnv registration failed: ${String(error)}`)
    }
  }

  /**
   * Addresses the gateway advertises: the LAN addresses when it listens on
   * every interface, otherwise exactly the interface it was told to bind.
   * @param boundPort - the port the gateway actually bound.
   * @returns URLs, best first.
   */
  const gatewayUrls = (boundPort) => {
    const addresses = gatewayConfig.listenHost === '0.0.0.0' || gatewayConfig.listenHost === '::'
      ? ['127.0.0.1', ...lanCandidates().map(({ address }) => address)]
      : [gatewayConfig.listenHost]
    return addresses.map((address) => `http://${address}:${String(boundPort)}/`)
  }

  /**
   * Start the gateway once the harness port is known, and restart it if that
   * port ever moves. Failures are logged and retried on a slow cadence: a
   * convenience must never take the boot down.
   * @param connection - the Connection service (session-cookie source).
   * @param upstreamPort - the harness web server port.
   */
  const ensureGateway = async (connection, upstreamPort) => {
    if (gatewayConfig === undefined) return
    if (gateway !== undefined && gatewayUpstreamPort === upstreamPort) return
    if (gatewayStarting) return
    if (Date.now() - gatewayFailedAt < GATEWAY_RETRY_MS) return
    gatewayStarting = true
    try {
      if (gateway !== undefined) {
        await gateway.close()
        gateway = undefined
        gatewayBoundPort = undefined
      }
      const started = startLanGateway({
        listenHost: gatewayConfig.listenHost,
        listenPort: gatewayConfig.listenPort,
        upstreamHost: '127.0.0.1',
        upstreamPort,
        credentialUrl: () => connection.authenticatedUrl(`http://127.0.0.1:${String(upstreamPort)}/`),
        allowCidrs: gatewayConfig.allowCidrs,
        allowLoopback: gatewayConfig.allowLoopback,
        username: gatewayConfig.username,
        password: gatewayConfig.password,
        injectHostClaim: gatewayConfig.injectHostClaim,
        log: (level, message) => {
          if (level === 'warn') warn(message)
          else note(message)
        }
      })
      const { port: bound } = await started.ready
      const minted = await started.refreshCookie().catch(() => false)
      gateway = started
      gatewayBoundPort = bound
      gatewayUpstreamPort = upstreamPort
      note(`lan-link gateway: listening on ${gatewayConfig.listenHost}:${String(bound)} -> http://127.0.0.1:${String(upstreamPort)}`)
      for (const url of gatewayUrls(bound)) note(`lan-link gateway: ${url}`)
      const loopbackBind = gatewayConfig.listenHost === '127.0.0.1' || gatewayConfig.listenHost === '::1'
      const status = [
        `# gateway status: listening on ${gatewayConfig.listenHost}:${String(bound)} -> http://127.0.0.1:${String(upstreamPort)}` +
          `; session ${minted ? 'minted' : 'NOT minted yet (requests answer 401 until it is)'}`
      ]
      if (!minted) {
        warn('lan-link gateway: the host session cookie could not be minted yet; requests answer 401 until it is')
      }
      if (gatewayConfig.allowCidrs.length === 0 && !loopbackBind) {
        const message =
          `lan-link gateway: allowCidrs is empty, so the gateway on ${gatewayConfig.listenHost} admits only this machine; ` +
          'add your LAN range (e.g. 192.168.0.0/24) to admit devices'
        warn(message)
        status.push(`# gateway status: WARNING ${message.replace('lan-link gateway: ', '')}`)
      }
      gatewayStatus = status
      if (gatewayConfig.verifySeam) {
        void started.probeHostClaimSeam()
          .then(({ ok, reason }) => {
            if (ok) note(`lan-link gateway: host claim verified — ${reason}`)
            else warn(`lan-link gateway: ${reason}`)
            gatewayStatus = [...status, `# gateway status: host claim ${ok ? 'verified' : 'NOT verified'} — ${reason}`]
          })
          .catch(() => {})
      }
    } catch (error) {
      gatewayFailedAt = Date.now()
      warn(`lan-link gateway: could not listen on ${gatewayConfig.listenHost}:${String(gatewayConfig.listenPort)}: ${String(error)}`)
    } finally {
      gatewayStarting = false
    }
  }

  const tick = async () => {
    try {
      const webServer = ctx.get?.('webServer')
      const connection = ctx.get?.('connection')
      if (webServer === undefined || connection === undefined) return
      const port = Number(webServer.port)
      if (!Number.isSafeInteger(port) || port <= 0) return
      if (typeof connection.authenticatedUrl !== 'function') return

      if (gatewayConfig !== undefined) await ensureGateway(connection, port)

      const linkFor = (address) => {
        try {
          return connection.authenticatedUrl(`http://${address}:${String(port)}`)
        } catch {
          return undefined
        }
      }

      const loopback = linkFor('127.0.0.1')
      if (loopback === undefined) return
      const lan = []
      for (const { address, iface } of lanCandidates()) {
        const url = linkFor(address)
        if (url !== undefined) lan.push({ iface, url })
      }

      const gatewayAll = gatewayBoundPort === undefined ? [] : gatewayUrls(gatewayBoundPort)
      const gatewayLan = gatewayAll.filter((url) => !url.startsWith('http://127.0.0.1:'))

      // The revision key deliberately excludes the timestamp: a tick that
      // changed nothing must not touch the file, or the publisher would write
      // once per interval forever.
      const key = [
        port,
        loopback,
        ...lan.map(({ iface, url }) => `${iface} ${url}`),
        gatewayBoundPort === undefined ? 'no-gateway' : `gateway ${String(gatewayBoundPort)}`,
        ...gatewayAll,
        ...gatewayStatus
      ].join('\n')
      if (key === lastKey) return

      const text = [
        HEADER,
        `# written ${new Date().toISOString()} (harness port ${port})`,
        '',
        ...(gatewayAll.length === 0
          ? []
          : [
              '# LAN gateway — open on any allowed device; no token needed',
              ...gatewayStatus,
              ...gatewayAll,
              ''
            ]),
        '# harness launch links (token) — sign a device in for 30 days',
        '# loopback, for a browser on this machine',
        loopback,
        '',
        lan.length === 0 ? '# no local-network address found' : '# local network, for a phone (interface above each link)',
        ...lan.flatMap(({ iface, url }) => [`# ${iface}`, url]),
        ''
      ].join('\n')

      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(fileName, text, { mode: 0o600 })
      await chmod(fileName, 0o600).catch(() => {})
      lastKey = key
      lastLanUrl = gatewayLan[0] ?? lan.at(-1)?.url ?? loopback
      note(`lan-link: wrote ${fileName} (${String(lan.length)} LAN link(s), gateway ${gatewayBoundPort === undefined ? 'off' : `port ${String(gatewayBoundPort)}`})`)
      registerShellVariable()
    } catch (error) {
      // Never rethrow: a convenience must not be able to fail a boot entry.
      warn(`lan-link: ${String(error)}`)
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  try {
    ctx.effect?.(() => () => {
      clearInterval(timer)
      if (gateway !== undefined) void gateway.close()
    }, 'lan-link: publish loop')
  } catch {
    /* ignore: the interval dies with the process anyway */
  }
  void tick()
}
