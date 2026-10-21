# Changelog

本文件记录 `dsh-lan-link` 的对外变更。0.2.0 是首个公开发布（GitHub 与 npm 同步）。

## 0.2.0 — 2026-10-18

### Added

- **启动链接发布**：等 `webServer` 绑定后，把本机每个 IPv4 地址的已认证链接写进
  `<harness home>/lan-link.txt`（权限 `0600`），并把 `DSH_LAN_LINK` 注册进 shell 环境。
  只在端口、网卡地址或网关状态真正变化时重写，避免每个 tick 都碰文件。
- **局域网网关（`gateway.enabled`）**：在同一进程里再起一个监听，终结设备连接后以
  「本机浏览器」的身份重新向回环发出 —— 代持本进程的浏览器会话 cookie、改写
  `Host`/`Origin` 通过 `/api` 同源围栏、只对被服务的 HTML 文档注入两段脚本
  （`crypto.randomUUID` 补丁与 host-claim 标记）。其余响应逐字节透传，压缩体保持压缩。
- **访问控制**：`allowCidrs`（IPv4 CIDR，除回环外允许的客户端）、`allowLoopback`、
  可选 Basic Auth（HTTP 与 WebSocket 升级同样检查）。
- **host-claim 缝隙自检**（`verifySeam`）：启动后探测一次被服务的客户端 bundle 是否仍读
  `__DSH_TRANSPORT__`，失效时在日志与 `lan-link.txt` 里明确告警，而不是静默降级。
- **`scripts/live-smoke.mjs`**：对真实 harness 进程的端到端冒烟，检查匿名访问 200 且注入
  生效、客户端 bundle 与直连逐字节一致、`/api/remote.mux` 的 WebSocket 升级可用。
- **发布链路**：`package.json` 补齐 `repository` / `homepage` / `bugs` / `publishConfig` /
  `engines.dsh`，新增 CI 与 `v*` 标签触发的 Trusted Publishing 工作流、`package-lock.json`、
  英文 README 与本变更日志。

### Fixed

- **设备重置 upgrade 隧道不再拖垮宿主**：设备断网时重置的是隧道而不是 close，Node 在把
  socket 交给 `'upgrade'` 后已移除自己的 error 监听，该 `ECONNRESET` 会变成 uncaught error；
  harness 宿主把未捕获异常视为致命，一部手机丢 Wi-Fi 曾导致桌面应用整个退出。现在为每条
  升级隧道补上 `error` 处理并随 `close` 清理。

### Notes

- 网关端口后面就是这台机器的用户：网关替所有被允许的设备出示主机会话。主要防线是
  `listenHost` + `allowCidrs`，Basic Auth 只能当额外一层。
- 宿主端没有按设备撤销：吊销会话只能删掉 `.credentials.yaml` 里的
  `client-connection/browser-session` 记录并重启。
