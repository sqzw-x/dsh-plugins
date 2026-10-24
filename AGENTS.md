# AGENTS.md — dsh-plugins

给在本仓库里工作的 agent 的约定。**先读这里，再动手。**

## 仓库是什么

一个 pnpm workspace，装着若干**独立发布的 DSH 插件**。`packages/*` 是产品代码，`tooling/*` 只服务于本仓库、不发布。

| 路径 | 内容 |
|---|---|
| `packages/dsh-focus-notify` | 回合结束聚焦提醒 / 系统通知（host + Web UI） |
| `packages/dsh-lan-link` | 局域网访问（host，TypeScript） |
| `packages/dsh-notes-context` | 笔记式上下文压缩（host） |
| `packages/dsh-prompt-sections` | 系统提示词段落编辑器（host + Web UI） |
| `tooling/dsh-plugin-toolkit` | 构建预设 `pluginBuild()`、测试替身、产物契约 |
| `.agents/skills/` | agent 技能目录（不 vendored，见其中 README） |

## 常用命令

```sh
pnpm install
pnpm verify                              # 全量 typecheck + test
pnpm --filter dsh-notes-context verify   # 只跑一个包（包名，不是目录名）
pnpm build                               # 构建全部（TS 包）
```

跑单个包时用**包名**：`dsh-focus-notify`、`dsh-lan-link`、`dsh-notes-context`、`dsh-prompt-sections`。

## 硬性约定

1. **不手改版本号。** 版本与 CHANGELOG 由 changesets 生成；改功能/修复就加一条 changeset：
   `pnpm changeset`（非交互环境可手写 `.changeset/<slug>.md`，frontmatter 里写包名与 bump 级别）。
2. **不提交 TS 包的 `lib/`。** 它由 `pnpm build` 生成、`prepack` 保证发布时存在。
3. **依赖版本写 `catalog:`。** 新依赖先在 `pnpm-workspace.yaml` 的 `catalog` 里登记一次，再在包里引用；禁止在包里写死已有依赖的版本。
4. **`@deepseek-ai/*` 一律是 peer。** 宿主提供它们；不要把它们放进 `dependencies`，也不要打进产物。
5. **Web UI 的客户端半区只 `require('react')`。** 不 require 任何 `@deepseek-ai/dsh-client-*` 包（内部 API 会变，且会连带前端失败）。样式用 `--dsw-alias-*` token。
6. **客户端 bundle 的 id 必须等于包名。** 用 `pluginBuild({ id: '包名' })` 就不会写错；CI 会用 `assertClientBundle` 校验。
7. **不新增第三个 workflow 文件。** CI 与发布各一个，按需改那一个。
8. **发布相关（trusted publishing 绑定、远程仓库设置）属于手工步骤**，代码里不要试图自动化。

## 产物契约（CI 会验）

- host：`lib/index.js` 导出一个 **ESM** 插件（`apply` 或默认导出服务类），`name` 与插件名一致；
- client（若有）：`lib/client.js` 以 `window.__ModuleLoader__.load({ id: <包名>, factory })` 包装的 **CJS**；
- `npm pack` 时只包含 `files` 里列的东西：`lib`、`cordis.patch.yml`、`locale`、`README*`、`LICENSE` 等。

## 测试

- 每个包 `npm test` 必须能在**干净 checkout + `pnpm install`** 后通过（CI 就是这么跑的）。
- 涉及路由的测试用 `dsh-plugin-toolkit/test` 的 `FakeWebServer` + `callRoute`，不要真绑端口。
- 涉及 prompt 装配的测试用 `mountPromptRegistry()` 起真实 `@deepseek-ai/dsh-system-prompt`，不要自己造假的 registry。
- 新增/修改客户端 bundle 后，至少跑一次 `assertClientBundle()`。

## 写中文/英文文案

- 包的 README 用中文主文档 + `README.en.md`（约定见现有包）。
- Web UI 的文案走客户端 locale 字典，中英两份键必须完全一致（测试会比对键集合）。

## 安全边界

- 插件在 host 进程内执行，等同 shell 权限：不要读凭据、不要外发数据。
- 路由必须同源校验（`Origin` vs `Host`）、写请求只收 `application/json`、请求体设上限。
- 本地状态文件权限 `0600`，写入要原子（临时文件 + rename）。

## 改完自检

```sh
pnpm verify
pnpm pack:dry     # 确认发布内容没缺文件
git status        # 不该出现 lib/、node_modules/、*.tgz
```
