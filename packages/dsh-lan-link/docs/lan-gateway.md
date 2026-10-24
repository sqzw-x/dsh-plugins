# LAN 网关设计记录 — `dsh-lan-link` gateway

**日期：** 2026-10-18, 01:30–02:20 (+08:00)
**范围：** `packages/dsh-lan-link` v0.2.0（新增 `lib/gateway.js` + `scripts/live-smoke.mjs`）
**被测 harness：** 桌面版 app 内置的 0.2.1-rc.2（`/Applications/DeepSeek Harness.app/…/app.asar/dsh`），进程 PID 90453，harness 端口 50908
**对照对象：** 第三方插件 `@smanx/dsh-proxy`（master@cda3f24，package.json 0.1.2）

## 0. 结论摘要

| 结论 | 判定 | 依据 |
|---|---|---|
| 桌面版 harness 不能自己绑局域网 | **成立** | `dsh-desktop-host` 写死 `--host 127.0.0.1 --port 0`；`dsh-host-webserver@0.2.1-rc.2` 的 schema 直接拒绝通配地址；Electron 侧用 `http://127.0.0.1:<port>` 换 cookie + loadURL |
| "反向代理 + 代持会话 + HTML 注入"是可行形态 | **成立** | 真机 9/9 检查通过；app 内热加载后匿名访问 200 |
| 必须改写客户端 JS 才能拿到完整界面 | **不成立** | 客户端判据读的是 `globalThis.__DSH_TRANSPORT__`，桌面壳用的同一个缝隙；HTML 注入一行即可 |
| 设备必须先用 `?token=` 换 cookie | **不成立（本实现）** | 网关在进程内换 cookie 并代所有设备出示；dsh-proxy 那种"转发浏览器 cookie"的设计才需要 |
| 固定端口需要连同 harness 端口一起固定 | **不成立（本实现）** | 网关每次启动重换 cookie，harness 端口可以继续随机 |

## 1. 客户端"我是不是主机"的判据

`@deepseek-ai/dsh-client-connection/lib/client.browser.js`（0.2.1-rc.2）：

```js
const transport = globals.__DSH_TRANSPORT__          // ← 唯一输入源
isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)
```

- 该全局**只有 Electron 桌面壳**会设置（`dsh-web-frontend/dist/assets/index-*.js` 里 `if (Ms !== void 0) globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`）。
- 局域网页面的 hostname 不可能是回环，且不可伪造（这正是它被选作判据的原因）。
- 因此**服务端无法代劳**：这是客户端本地决策。

**缝隙**：判据只读那个全局对象，且 `{ownsHost:true}` 里缺 `rpc`/`fetch`/`openStream`/`createWebSocket`/`streamBaseUrl` 时会各自回落到同源默认实现，所以注入 `{ownsHost:true}` 是安全且完整的。（`run()` 只额外读 `i?.loadBundle`，缺失即默认加载器。）

## 2. 会话凭据：authority 绑定的事实

`dsh-client-connection` 的 `authenticate()`：

```js
const authority = requestAudience(request.headers)      // 只看 Host
const value = cookieValue(rawCookie, cookieName(authority))   // cookie 名 = 'dsh-auth-' + sha256(authority)
if (payload.authority !== authority) return undefined
```

实测（同一进程，两条路径）：

| 取 cookie 的路径 | cookie 名 |
|---|---|
| 直连 `http://127.0.0.1:50908/?token=…` | `dsh-auth-1KJvIN5lrcH2VtLVfqpEx_gWnRtkSRkJ_Ta6UISxS6M` |
| 经 dsh-proxy 类代理（Host 被改写成 `127.0.0.1:50908`） | 同上，逐字相同 |

推论：① Host 改写后，代理请求与本地请求在 harness 眼里无法区分；② 网关**自己**持证最干净——设备不存 cookie，harness 端口变化不影响设备，token 不必离开这台机器。

## 3. 与 dsh-proxy 的取舍（实测数据）

| 维度 | dsh-proxy | 本实现 |
|---|---|---|
| 客户端信任 | 按字节改写 `isLoopback:` 表达式（两份 needle，其中一份在 0.2.1-rc.2 已不存在 = 死代码） | HTML head 注入 `{ownsHost:true}` |
| 响应处理 | 对**每个** JS/HTML 响应全量缓冲 + 同步 zlib 解压/重压 | 只对文档请求 `accept-encoding: identity` 并注入；其余逐字节透传 |
| 5.6 MB 客户端 bundle | 会被缓冲 + 解压 + 重压 | 实测与直连**逐字节一致**（5,594,889 bytes） |
| 设备登录 | 需先访问 `?token=…`（文档未写，实测匿名 401） | 无需 token |
| 版本脆弱性 | needle 随上游改版静默失效 | 缝隙失效时 `verifySeam` 明确告警 |

## 4. 实现边界

- **改写**：`Host` → `127.0.0.1:<harnessPort>`；`Origin` → 同 authority；`Cookie` → 网关自持的会话；文档请求的 `accept-encoding` → `identity`；HTML 文档 head 注入两段脚本。
- **不改写**：其余响应逐字节透传（含压缩体与 `content-length`）；`dsh-auth-*` 响应 cookie 不下发给设备；不设 `x-forwarded-*`（因此 harness 日志里来源看起来是本机——已知代价）。
- **准入**：源 IP 白名单（`allowCidrs`，仅 IPv4 CIDR + `::1`）+ 可选 Basic；回环默认放行、可关。
- **自愈**：上游 401 时重换 cookie 并重放一次（仅无 body 请求）。
- **自检**：启动后取回 index + connection 客户端 bundle，确认仍含 `ownsHost`；结果写进 `lan-link.txt`（桌面版 stdout 是 /dev/null，文件才是可见通道）。
- **隧道生命周期**：upgrade 路径必须为客户端 socket 挂 `error` 监听。Node 在 emit `upgrade` 前已摘除自己的 socket 监听，设备掉线的 TCP RST 否则变成未捕获错误事件——而 host 对未捕获异常是致命的（见 §5 事故记录）。监听器只销毁该条隧道，不触碰其他连接。

## 5. 验证记录

| 层级 | 内容 | 结果 |
|---|---|---|
| 单元（`node --test test/`） | 注入/幂等、CIDR 与回环策略、Basic、Host/Origin/cookie、非文档逐字节透传、压缩 HTML 兜底、401 自愈、403、Basic 双路径、WebSocket 隧道、设备 RST 回归（子进程 fixture）、缝隙探测、文件产出与 `DSH_LAN_LINK` | 21/21 通过 |
| 真机冒烟（`scripts/live-smoke.mjs`） | 会话换取、匿名 200、两段脚本注入、bundle 逐字节一致、缝隙探测、`/api/remote.mux` 升级、会话复用 | 9/9 通过 |
| 应用内验收 | 运行中的 app（PID 90453）热加载后：`*:3081` LISTEN、`curl http://192.168.0.2:3081/` → 200 且注入生效、WS → `HTTP/1.1 101 Switching Protocols` | 通过 |

**WebSocket 路径**：`/api/remote.mux`（`dsh-api-gateway` 的 `REMOTE_STREAM_MUX_PATH`，浏览器侧所有流都走它）。第一次用 `/api/events.mux` 探测超时纯属路径猜错——未知 upgrade 路径 harness 不回应。

**事故记录（2026-10-18）**：桌面版在 02:26:52 整体退出，崩溃日志为 `dsh: fatal uncaught exception: Error: read ECONNRESET`（`syscall: 'read'`，`errno: -54`）。根因是设备 WebSocket 隧道被 RST 时，upgrade 路径的客户端 socket 没有 `error` 监听，异常以未捕获错误事件逃逸到 host。用同一运行时（Electron 44.7.0 / Node 24.21.0）以真实网关代码复现出的栈与崩溃日志逐字一致；补 `socket.on('error')` 后同一场景存活、隧道照常工作。`test/fixtures/upgrade-reset.mjs` 固化该场景，且必须子进程运行——回归时它会直接杀掉观察它的进程。

## 6. 风险与约束

1. **端口即权限**：网关代所有被允许设备出示主机会话，谁能连上端口谁就是这台机器的用户。主要防线是 `listenHost` + `allowCidrs`，Basic 只是附加层（明文 HTTP 可嗅探）。
2. **缝隙是可变的**：上游若不再读 `__DSH_TRANSPORT__`，页面降级为"远程访客"模式（功能受限但不报错）；`verifySeam` 会在文件里写明。
3. **来源失真**：改写后 harness 无法区分本机与局域网设备，审计只能靠网关自己。
4. **不支持 IPv6 网段**：`allowCidrs` 只解析 IPv4 CIDR 与 `::1`；需要时再扩。

## 7. 复验步骤

```sh
cd ~/projects/dsh-plugins/packages/dsh-lan-link
node --test test/                                   # 21/21
node scripts/live-smoke.mjs --host 192.168.0.2 --port 3081
cat ~/.dsh/lan-link.txt | sed -n '/LAN gateway/,+5p' # 状态行 + 链接
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.0.2:3081/   # 200
```
