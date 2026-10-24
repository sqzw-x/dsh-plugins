# dsh-lan-link

[![CI](https://github.com/sqzw-x/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/sqzw-x/dsh-plugins/actions/workflows/ci.yml)

[English](README.en.md) | 简体中文

把**当前这个 harness 进程**的局域网访问交给别的设备：一条是落盘的、带 launch token 的启动链接，另一条（可选）是本进程自己在局域网端口上对外服务的**网关**。

## 两种链接的区别

| | token 链接 | 网关链接（`gateway.enabled`） |
|---|---|---|
| 设备需要什么 | 粘一次 `?token=…` 链接 | 什么都不用，直接打开 |
| 谁能用 | 只要网络能到达 harness 监听地址 | 源 IP 在 `allowCidrs` 内（或本机） |
| 端口 | harness 自己的端口（桌面版是回环，手机不可达） | 网关自己的固定端口 |
| 会话凭据 | 落在**手机**上（cookie，30 天） | 留在**这台机器**上（网关代持） |
| 崩溃/重启后 | harness 端口变了就失效 | 每次启动自动重新换取，设备无感 |

## 为什么需要它

harness 每个进程随机生成一个 launch token，只在启动时打印一次：

```
dsh web: http://127.0.0.1:19387/?token=…     (LAN: http://192.168.0.2:19387/?token=…)
```

`GET /?token=…` 是唯一能换取「authority 绑定」的浏览器会话 cookie 的入口（cookie 默认 30 天，`/api` 与 WebSocket 全靠它），而 token 本身不落任何盘。桌面版把这一行 pipe 到自己的 stdout，而 Finder 启动的 .app 的 stdout 是 `/dev/null` —— 所以桌面版上这个链接实际上无法观测，手机也就没法登录。

宿主插件和 Connection 服务在同一个进程里，可以直接向它要任意 authority 的已认证 URL。本插件等 web server 绑定后，把每个本机 IPv4 地址的链接写进 `<harness home>/lan-link.txt`，并把 `DSH_LAN_LINK` 注册进 shell 环境。

但**链接本身不会让手机变得能连上**：桌面版的 harness 监听在回环地址上（它必须如此，Electron 窗口就靠这个地址），而 harness 明确拒绝绑到 `0.0.0.0`。所以真正的局域网访问要么靠别的东西转发，要么打开本插件的网关。

## 局域网网关

打开 `gateway.enabled` 后，本插件在**同一个进程里**再起一个监听，把设备连接终结在这里，并以「本机浏览器」的身份重新向回环发出：

1. **代持会话**：通过 `connection.authenticatedUrl()` 在回环上换一张本进程的浏览器会话 cookie，之后每个转发请求都替设备出示它 —— 设备不需要 token，凭据不离开这台机器；harness 拒绝时自动重换一次。
2. **重写 Host/Origin**：让请求通过 harness 的 `/api` 同源围栏，和本机访问完全一致。
3. **注入两段脚本**到被服务的 HTML 文档里：`crypto.randomUUID` 补丁（局域网明文 HTTP 不是安全上下文，浏览器会禁用该 API），以及桌面壳自己用来声明「我是主机」的那个标记 —— 这样界面按完整主机界面渲染，而不是降级成「远程访客」模式。

除此之外**什么都不改**：其余响应逐字节透传、压缩体保持压缩，几 MB 的客户端 bundle 不做缓冲也不重压缩（只有文档会被要求以未压缩形式取回）。这比"改写传输中的 JS 字节"要稳得多：harness 改版不会让补丁静默失效，`verifySeam` 还会在启动时探测一次并明确告警。

### 配置

```yaml
- id: lan-link
  name: 'dsh-lan-link'
  config:
    fileName: 'lan-link.txt'
    intervalMs: 1000
    gateway:
      enabled: true
      listenHost: '0.0.0.0'      # 绑哪个网卡；0.0.0.0 = 全部
      listenPort: 3081           # 设备访问的端口；0 = 让系统挑
      allowCidrs:                # 除本机回环外允许的客户端
        - '192.168.0.0/24'       # 只写你自己拥有的网段
      allowLoopback: true        # 是否允许本机访问（默认 true）
      username: ''               # 可选 Basic Auth，两者都非空才生效
      password: ''
      injectHostClaim: true      # 完整主机界面；false = 保持"远程访客"降级
      verifySeam: true           # 启动时探测 host-claim 缝隙是否仍在
```

端口固定这件事只需要管网关端口：harness 自己的端口仍然可以是 `--port 0` 随机值，网关每次启动都会重新换取会话。

## 产出

`~/.dsh/lan-link.txt`（权限 0600）：

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

每次 harness 启动覆盖一次；端口、网卡地址或网关状态变化时会重写。`DSH_LAN_LINK` 优先给网关链接。

## 安装

### 插件管理器

在「设置 → 插件」里装上 `dsh-lan-link`，启用后按提示重启。桌面版与 Web 版都适用。

### 命令行

```sh
# 从 npm
dsh plugin --profile <profile> add dsh-lan-link

# 从 GitHub
dsh plugin --profile <profile> add "github:sqzw-x/dsh-plugins#path:packages/dsh-lan-link"
```

### desktop profile（Electron 独占）

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-lan-link": "^0.2.0" },
"dsh": { "profile": { "bundles": [ …, "dsh-lan-link" ] } }
```

然后在 profile 目录跑一次 `pnpm install`（或用 app 的插件管理器），重启 app 生效。开发时把依赖换成 `link:/path/to/dsh-lan-link` 即可。

> 注意：desktop profile 由 Electron 独占管理，`dsh plugin --profile desktop …` 会被拒绝（`profile "desktop" is managed exclusively by the Electron application`），只能直接改 profile 目录。

停用：`- id: lan-link` + `disabled: true`（网关随之关闭）；只关网关则 `gateway.enabled: false`。

## 验证

```sh
cat ~/.dsh/lan-link.txt
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.0.2:3081/     # 期望 200，无需 token
# 重启后在新会话里：
# echo "$DSH_LAN_LINK"
```

带真实 harness 的端到端冒烟（当前进程必须正在运行）：

```sh
node scripts/live-smoke.mjs                    # 读 ~/.dsh/lan-link.txt 里的 token
node scripts/live-smoke.mjs --port 3081 --host 192.168.0.2
```

它会检查：匿名访问返回 200 且两段脚本已注入、客户端 bundle 与直连逐字节一致、host-claim 缝隙探测、以及 `/api/remote.mux` 的 WebSocket 升级能打通。

## 安全

- **网关端口后面就是这台机器的用户**：网关替所有被允许的设备出示主机会话，所以访问控制靠的是"谁能连上这个端口"。把 `listenHost` 收窄到一个网卡、把 `allowCidrs` 收到你自己的网段，是主要防线；Basic Auth 只能当额外一层（明文 HTTP 上还会被嗅探）。
- token 链接里的 `?token=` 能换到一个会话，该会话可以触达**全部**具备工具能力的 API —— 等价于在这台机器上的 shell 权限，且宿主端**没有按设备撤销**（要吊销只能删掉 `.credentials.yaml` 里 `client-connection/browser-session` 记录并重启，会踢掉所有设备）。
- harness 本身故意拒绝 `--host 0.0.0.0`，就是为了不把这份能力摊到网络上。打开网关等于自愿放弃那层保护，并且 harness 日志里从此分不出来源（转发请求看起来都来自本机）。只想在自家可信网络里用，再打开它。
- 需要真正的"人在外面也能用"时，正确工具是 harness 的配对/隧道那类方案，而不是这个网关。

## 回滚

从 profile 的 `dsh.profile.bundles` 里删掉 `dsh-lan-link`（以及 `dependencies` 里的那行）后重启即可；只想关掉对外服务就设 `gateway.enabled: false`。文件本身可以留着或删掉。
