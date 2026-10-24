# DSH plugins

DeepSeek Harness（DSH）插件合集，一个 pnpm workspace、一套 CI、一套发布流水线，**每个插件仍是独立的 npm 包、独立版本号**。

| 包 | 作用 | 形态 |
|---|---|---|
| [`dsh-focus-notify`](packages/dsh-focus-notify) | 会话/回合结束时聚焦提醒与系统通知 | host + Web UI |
| [`dsh-lan-link`](packages/dsh-lan-link) | 把本机 harness 发布到局域网（带鉴权的启动链接） | host（纯 JS，无构建） |
| [`dsh-notes-context`](packages/dsh-notes-context) | 笔记式上下文压缩：窗口滚动零模型调用，原文可回读 | host |
| [`dsh-prompt-sections`](packages/dsh-prompt-sections) | 自建系统提示词段落，落点可选开头/中间/末尾，带实时预览 | host + Web UI |

## 快速开始

```sh
pnpm install          # 安装整个 workspace
pnpm verify           # 全量 typecheck + test（CI 跑的就是这条）
pnpm build            # 构建所有带 build 脚本的包
```

装到 DSH profile 里（本地开发用 link，改完 `pnpm build` 即生效）：

```sh
dsh plugin --profile web add link:$PWD/packages/dsh-prompt-sections
```

## 目录

```
packages/             每个目录是一个独立发布的 npm 包
tooling/              仅本仓库使用的开发工具（不发布）
  dsh-plugin-toolkit    构建预设 + 测试替身 + 产物契约
.agents/skills/       agent 用的开发 skill（不 vendored，见该目录 README）
.github/workflows/    CI 与发布
.changeset/           版本与 changelog 的唯一入口
```

## 新增一个插件

1. `mkdir packages/dsh-<name>`，复制任一 TS 包的 `package.json` / `tsconfig.json` / `tsdown.config.ts` 骨架；
2. `tsdown.config.ts` 只写一行 `export default pluginBuild({ id: 'dsh-<name>' })`；
3. `tsconfig.json` 只写 `{ "extends": "../../tsconfig.base.json", "include": ["src"] }`；
4. 依赖版本写 `catalog:`（统一在 `pnpm-workspace.yaml` 里管理）；
5. `pnpm install`，然后 `pnpm --filter dsh-<name> verify`；
6. 加一个 changeset（见下），提交。

## 版本与发布

**每个包独立版本、独立 tag**，由 [changesets](https://github.com/changesets/changesets) 驱动：

```sh
pnpm changeset          # 选择受影响的包与 bump 级别，写一条变更说明
```

- PR 里只提交 changeset，**不要手改版本号**；
- 合并到 `main` 后，Release workflow 会自动开一个 “Version Packages” PR（改版本 + 写 CHANGELOG）；
- 合并那个 PR 时发布到 npm，并打 `包名@版本` 标签（例如 `dsh-notes-context@0.2.2`）；
- 发布走 npm Trusted Publishing（OIDC），不需要 `NPM_TOKEN`；新增包要先把 `sqzw-x/dsh-plugins` + `.github/workflows/publish.yml` 绑定到该包的 trusted publisher 上。

## 仓库历史

三个原本独立发布的插件（`dsh-focus-notify`、`dsh-lan-link`、`dsh-notes-context`）通过 `git subtree add` 并入本仓库：**原始提交仍然是祖先**，`git log` 可以看到全部历史；但按路径追溯时，路径归属从导入提交开始（`git log -- <path>` 不会穿透到导入前）。按内容回溯用 `git log -S<字符串> --all` 不受影响。

独立仓库将保留为存档并指向这里；npm 上的包名、版本号与安装命令不变。

## 兼容性

所有包以 `@deepseek-ai/*` **0.2.1-rc.2** 为构建与测试基线（见 `pnpm-workspace.yaml` 的 catalog）。升级 DSH 时改 catalog 一处，全仓库一起升级、一起验证。

## 许可

MIT。
