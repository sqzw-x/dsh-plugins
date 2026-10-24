# Vendored skills

这里放**随仓库分发**的 agent 技能，内容是上游项目的原样拷贝，纳入本仓库版本管理，方便任何 checkout 都能直接使用。

| 技能 | 上游 | 当前版本 | 同步方式 |
|---|---|---|---|
| `dsh-plugin-dev-skill` | https://github.com/green-dalii/dsh-plugin-dev-skill | `0.6.3`（见其 `VERSION`） | `pnpm sync-skill` |

## 为什么是 vendored 而不是 submodule

DSH 从 `<仓库>/.agents/skills/<name>/SKILL.md` 读取技能。submodule 在未初始化的 checkout 里是一个空目录，技能会**静默消失**；vendored 拷贝则永远在。代价是升级要显式同步一次，这不是问题：上游发版频率低，而且 `scripts/sync-skill.sh` 会把差异打出来。

## 升级

```sh
pnpm sync-skill              # 拉取上游最新 tag 并覆盖本地拷贝
pnpm sync-skill --check      # 只比较，不写入
```

覆盖后请一并更新本文件的版本号与 `dsh-plugins/AGENTS.md` 里引用的内容（技能里若改了 DSH 基线，要同步 `pnpm-workspace.yaml` 的 catalog）。
