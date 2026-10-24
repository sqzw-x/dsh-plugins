# dsh-lan-link

[![CI](https://github.com/sqzw-x/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/sqzw-x/dsh-plugins/actions/workflows/ci.yml)

English | [简体中文](README.md)

Hand LAN access to **the harness process that is running right now** from another device. Two ways: a launch link with a token, written to disk; and (optionally) a **gateway** this process serves on a fixed LAN port itself.

## The two kinds of link

| | token link | gateway link (`gateway.enabled`) |
|---|---|---|
| What the device needs | paste a `?token=…` link once | nothing — just open it |
| Who can use it | anyone who can reach the harness listener | source IP inside `allowCidrs` (or this machine) |
| Port | the harness's own port (loopback on Desktop, unreachable from a phone) | the gateway's own fixed port |
| Where the session lives | on the **device** (cookie, 30 days) | on **this machine** (the gateway holds it) |
| After a crash/restart | dead once the harness port moves | re-minted on every start; devices notice nothing |

## Why this exists

The harness mints one random launch token per process and prints it exactly once at startup:

```
dsh web: http://127.0.0.1:19387/?token=…     (LAN: http://192.168.0.2:19387/?token=…)
```

`GET /?token=…` is the only way to obtain the authority-bound browser-session cookie (`/api` and the WebSocket upgrade both require it; the cookie lasts 30 days), and the token itself is never written to disk. The Desktop app pipes that line to its own stdout — and a Finder-launched `.app` has `/dev/null` for stdout — so on Desktop the link is effectively unobservable, and a phone pointed at the LAN address has no way to sign in.

A host plugin lives in the same process as the Connection service, so it can simply ask for the authenticated URL of any authority. Once the web server has bound, this plugin writes one link per local IPv4 address to `<harness home>/lan-link.txt` and registers `DSH_LAN_LINK` in the shell environment.

But **a link does not make the phone reachable**: the Desktop harness listens on loopback (it has to — the Electron window uses that address), and the harness refuses to bind `0.0.0.0`. Real LAN access therefore needs something in front, or this plugin's gateway.

## LAN gateway

With `gateway.enabled`, the plugin opens a second listener **inside the same process**, terminates device connections there, and re-issues them over loopback as the host's own browser would:

1. **Holds the session**: it exchanges `connection.authenticatedUrl()` for this process's browser-session cookie over loopback and presents that cookie for every forwarded request. Devices need no token, and the credential never leaves this machine. If the harness rejects it, the gateway re-mints once and replays.
2. **Rewrites Host/Origin** so requests pass the harness's `/api` same-origin fence exactly as local access does.
3. **Injects two scripts** into served HTML documents: a `crypto.randomUUID` polyfill (a plain-HTTP LAN page is not a secure context, so browsers withhold that API) and the same host-claim flag the desktop shell sets — so the UI renders the full host surface instead of degrading to remote-visitor mode.

Nothing else is touched: every other response streams through byte-for-byte, compressed bodies stay compressed, and multi-megabyte client bundles are neither buffered nor recompressed (only the document is fetched uncompressed). That is far stabler than rewriting JS bytes in transit: a harness update cannot silently break a patch, and `verifySeam` probes the seam at startup and says so loudly when it is gone.

### Configuration

```yaml
- id: lan-link
  name: 'dsh-lan-link'
  config:
    fileName: 'lan-link.txt'
    intervalMs: 1000
    gateway:
      enabled: true
      listenHost: '0.0.0.0'      # interface to bind; 0.0.0.0 = every interface
      listenPort: 3081           # port devices open; 0 = OS-assigned
      allowCidrs:                # clients admitted besides loopback
        - '192.168.0.0/24'       # keep this to a network you own
      allowLoopback: true        # admit this machine (default true)
      username: ''               # optional Basic Auth (needs both fields)
      password: ''
      injectHostClaim: true      # full host surface; false = keep remote-visitor mode
      verifySeam: true           # probe the host-claim seam at startup
```

Only the gateway port needs to be fixed: the harness itself can keep using `--port 0`, because the gateway re-mints its session on every start.

## Output

`~/.dsh/lan-link.txt` (mode 0600):

```
# dsh-lan-link — authenticated LAN access for this harness process.
…
# written 2026-10-17T18:10:00.000Z (harness port 19387)

# LAN gateway — open on any allowed device; no token needed
http://192.168.0.2:3081/

# harness launch links (token) — sign a device in for 30 days
# loopback, for a browser on this machine
http://127.0.0.1:19387/?token=…

# local network, for a phone (interface above each link)
# en0
http://192.168.0.2:19387/?token=…
```

The file is rewritten once per harness start, and again whenever the port, the address set or the gateway state changes. `DSH_LAN_LINK` prefers the gateway link.

## Install

### Plugin manager

Install `dsh-lan-link` from Settings → Plugins, enable it, and restart when prompted. Works for both Desktop and Web.

### Command line

```sh
# From npm (prebuilt, no local build)
dsh plugin --profile <profile> add dsh-lan-link
```

Installing from the GitHub source also works, but pnpm will ask you to allow the
package's build script (`prepack` produces `lib/`). Add the `allowBuilds` entry
pnpm prints to the profile's `pnpm-workspace.yaml`, then retry:

```sh
dsh plugin --profile <profile> add "github:sqzw-x/dsh-plugins#path:packages/dsh-lan-link"
```

### desktop profile (managed by Electron)

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-lan-link": "^0.2.0" },
"dsh": { "profile": { "bundles": [ …, "dsh-lan-link" ] } }
```

Then run `pnpm install` once in the profile directory (or use the app's plugin manager) and restart. For development, point the dependency at `link:/path/to/dsh-lan-link` instead.

> Note: the desktop profile is managed exclusively by Electron, so `dsh plugin --profile desktop …` is rejected (`profile "desktop" is managed exclusively by the Electron application`); edit the profile directory directly.

Disable with `- id: lan-link` + `disabled: true` (the gateway goes with it); to turn off only the gateway, set `gateway.enabled: false`.

## Verify

```sh
cat ~/.dsh/lan-link.txt
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.0.2:3081/     # expect 200, no token
# in a new shell after a restart:
# echo "$DSH_LAN_LINK"
```

End-to-end smoke against a live harness (the process must be running):

```sh
node scripts/live-smoke.ts                    # reads the token from ~/.dsh/lan-link.txt
node scripts/live-smoke.ts --port 3081 --host 192.168.0.2
```

It checks that anonymous access returns 200 with both scripts injected, that the client bundle is byte-identical to the direct one, the host-claim seam probe, and that the `/api/remote.mux` WebSocket upgrade goes through.

## Security

- **Behind the gateway port is this machine's user**: the gateway presents the host session for every admitted device, so the access control is "who can reach this port". Narrowing `listenHost` to one interface and `allowCidrs` to your own subnet is the primary defence; Basic Auth is only an extra layer (and is sniffable over plain HTTP).
- The `?token=` in a token link mints a session that reaches **every** tool-capable API — equivalent to shell access on this machine — and the host **cannot revoke a single device** (revoking means deleting the `client-connection/browser-session` record in `.credentials.yaml` and restarting, which kicks every device out).
- The harness deliberately refuses `--host 0.0.0.0` precisely to keep that capability off the network. Enabling the gateway knowingly gives that up, and the harness log can no longer tell where a request came from (forwarded requests all look local). Turn it on only inside a network you trust.
- For "usable from outside" access, the right tool is the harness's pairing/tunnel story, not this gateway.

## Rollback

Remove `dsh-lan-link` from `dsh.profile.bundles` (and the `dependencies` line) and restart; to stop serving devices only, set `gateway.enabled: false`. The file itself can be kept or deleted.
