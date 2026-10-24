/**
 * dsh-lan-link tests — the publisher must never throw, must wait for a bound
 * port, must write once per real change (port or address set), and must stay
 * owner-only.
 *
 * Run: node --test test/lan-link.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../lib/index.js'

/** Minimal Cordis-context double covering exactly what the plugin touches. */
function fakeContext({ webServer, connection, shellEnv } = {}) {
  const services = new Map()
  if (webServer !== undefined) services.set('webServer', webServer)
  if (connection !== undefined) services.set('connection', connection)
  if (shellEnv !== undefined) services.set('shellEnv', shellEnv)
  const effects = []
  return {
    get: (service) => services.get(service),
    effect: (register) => {
      effects.push(register())
    },
    logger: { info() {}, warn() {} },
    dispose: () => {
      for (const disposer of effects) disposer?.()
    }
  }
}

function machineLanAddresses() {
  const found = new Set()
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === 'IPv4' && entry.internal === false) found.add(entry.address)
    }
  }
  return [...found].sort()
}

async function withHarnessHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'lan-link-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

async function waitForFile(file, budgetMs = 3000) {
  const until = Date.now() + budgetMs
  for (;;) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      if (Date.now() > until) return undefined
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

const workingConnection = { authenticatedUrl: (base) => `${base}/?token=fake-token` }

test('exports the stable plugin name', () => {
  assert.equal(name, 'lan-link')
})

test('stays silent — and never throws — without its services', async () => {
  await withHarnessHome(async (home) => {
    const ctx = fakeContext()
    try {
      assert.doesNotThrow(() => apply(ctx, { intervalMs: 20 }))
      assert.equal(await waitForFile(join(home, 'lan-link.txt'), 200), undefined)
    } finally {
      ctx.dispose()
    }
  })
})

test('waits for a bound port before writing', async () => {
  await withHarnessHome(async (home) => {
    const file = join(home, 'lan-link.txt')
    const webServer = { port: 0 }
    const ctx = fakeContext({ webServer, connection: workingConnection })
    try {
      apply(ctx, { intervalMs: 20 })
      assert.equal(await waitForFile(file, 200), undefined)
      webServer.port = 19387
      assert.ok((await waitForFile(file)) !== undefined, 'file appears once the port is bound')
    } finally {
      ctx.dispose()
    }
  })
})

test('writes one link per address, 0600, and registers DSH_LAN_LINK once', async () => {
  await withHarnessHome(async (home) => {
    const file = join(home, 'lan-link.txt')
    const registered = []
    const shellEnv = { register: (entry) => registered.push(entry) }
    const ctx = fakeContext({ webServer: { port: 19387 }, connection: workingConnection, shellEnv })
    try {
      apply(ctx, { intervalMs: 20 })
      const text = await waitForFile(file)
      assert.ok(text !== undefined, 'file is written')
      assert.match(text, /http:\/\/127\.0\.0\.1:19387\/\?token=fake-token/)
      for (const address of machineLanAddresses()) {
        assert.match(text, new RegExp(`http://${address.replaceAll('.', '\\.')}:19387/\\?token=fake-token`))
      }
      assert.equal((await stat(file)).mode & 0o777, 0o600, 'credential file is owner-only')

      assert.equal(registered.length, 1, 'shellEnv registered exactly once')
      assert.equal(registered[0].name, 'lan-link')
      assert.ok(Object.hasOwn(registered[0].variables, 'DSH_LAN_LINK'))
      const expectedLast = machineLanAddresses().at(-1)
      assert.equal(
        registered[0].resolve().DSH_LAN_LINK,
        expectedLast === undefined
          ? 'http://127.0.0.1:19387/?token=fake-token'
          : `http://${expectedLast}:19387/?token=fake-token`
      )

      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(registered.length, 1, 'later ticks do not re-register')
    } finally {
      ctx.dispose()
    }
  })
})

test('does not rewrite the file while nothing changes, and rewrites on a port change', async () => {
  await withHarnessHome(async (home) => {
    const file = join(home, 'lan-link.txt')
    const webServer = { port: 19387 }
    const ctx = fakeContext({ webServer, connection: workingConnection })
    try {
      apply(ctx, { intervalMs: 20 })
      assert.ok((await waitForFile(file)) !== undefined)
      const before = (await stat(file)).mtimeMs
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal((await stat(file)).mtimeMs, before, 'unchanged state must not touch the file')

      webServer.port = 19388
      const until = Date.now() + 2000
      let text
      for (;;) {
        text = await readFile(file, 'utf8')
        if (text.includes(':19388/') || Date.now() > until) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.match(text, /:19388\/\?token=fake-token/)
    } finally {
      ctx.dispose()
    }
  })
})

test('accepts an absolute fileName outside the harness home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lan-link-abs-'))
  const file = join(directory, 'nested', 'lan-link.txt')
  const ctx = fakeContext({ webServer: { port: 19387 }, connection: workingConnection })
  try {
    apply(ctx, { fileName: file, intervalMs: 20 })
    assert.ok((await waitForFile(file)) !== undefined, 'absolute path is honoured')
  } finally {
    ctx.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('survives a throwing connection service', async () => {
  await withHarnessHome(async (home) => {
    const ctx = fakeContext({
      webServer: { port: 19387 },
      connection: {
        authenticatedUrl: () => {
          throw new Error('no connection')
        }
      }
    })
    try {
      assert.doesNotThrow(() => apply(ctx, { intervalMs: 20 }))
      assert.equal(await waitForFile(join(home, 'lan-link.txt'), 200), undefined)
    } finally {
      ctx.dispose()
    }
  })
})

test('gateway: starts on the requested interface, publishes its link first, and serves documents', async () => {
  await withHarnessHome(async (home) => {
    const file = join(home, 'lan-link.txt')
    let minted = 0
    const upstream = (await import('node:http')).createServer((req, res) => {
      if (req.url?.startsWith('/?token=')) {
        minted += 1
        res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-test=SESSION; Path=/' })
        res.end()
        return
      }
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><head><title>harness</title></head><body>ok</body></html>')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = upstream.address().port

    const registered = []
    const ctx = fakeContext({
      webServer: { port: upstreamPort },
      // Mimics the real service: appends the launch token to any authority.
      connection: { authenticatedUrl: (base) => `${base.replace(/\/$/, '')}/?token=fake-token` },
      shellEnv: { register: (entry) => registered.push(entry) }
    })
    try {
      // The production shape: every interface, with the allow list narrowing
      // admission to the range the owner controls (here: this machine only).
      apply(ctx, {
        intervalMs: 20,
        gateway: { enabled: true, listenHost: '0.0.0.0', listenPort: 0, allowCidrs: ['127.0.0.0/8'], verifySeam: false }
      })

      const text = await waitForFile(file)
      assert.ok(text !== undefined, 'the file is written once the gateway is up')
      assert.ok(text.includes('# LAN gateway'), 'the gateway section is labelled')
      assert.match(text, /# gateway status: listening on 0\.0\.0\.0:\d+ -> http:\/\/127\.0\.0\.1:\d+; session minted/, 'the file reports the gateway self-check')
      assert.ok(text.includes('?token=fake-token'), 'the token links are kept alongside it')
      assert.equal(minted, 1, 'the gateway minted its own session over loopback')

      const gatewayLines = text
        .split('\n')
        .filter((line) => /^http:\/\/[\d.]+:\d+\/$/.test(line))
      assert.ok(gatewayLines.length > 0, 'at least one tokenless gateway link is published')
      const localGateway = gatewayLines.find((line) => line.startsWith('http://127.0.0.1:'))
      assert.ok(localGateway !== undefined, 'the loopback gateway link is published too')

      const response = await fetch(localGateway)
      const body = await response.text()
      assert.equal(response.status, 200, 'a device needs no token to load the page')
      assert.ok(body.includes('__DSH_TRANSPORT__={ownsHost:true}'), 'the host-claim flag reaches the device')
      assert.ok(body.includes('crypto.randomUUID=function'), 'the polyfill reaches the device')

      const published = gatewayLines.filter((line) => !line.startsWith('http://127.0.0.1:'))
      assert.equal(
        registered[0].resolve().DSH_LAN_LINK,
        published[0] ?? localGateway,
        'DSH_LAN_LINK prefers a device-reachable gateway link'
      )
    } finally {
      ctx.dispose()
      await new Promise((resolve) => {
        upstream.closeAllConnections?.()
        upstream.close(resolve)
      })
    }
  })
})
