# Agent skills

本仓库**不**随仓库分发（vendor）agent 技能。

- 插件开发用宿主自带的那一套：DSH 每次安装都带 `cordis-plugin-development`（以及 `cordis-composition-reference`、`editing-cordis-compositions`），它和运行时同版本，不需要手动同步。
- 之前 vendored 的第三方技能 `dsh-plugin-dev-skill` 已删除（提交 `a16d60f`）。内容仍在 git 历史里，需要时用
  `git show a16d60f^:.agents/skills/dsh-plugin-dev-skill/SKILL.md` 取；配套的 `scripts/sync-skill.sh` 与 `pnpm sync-skill` 一并移除。

如果将来还要 vendored 某个技能，请在本文件记下：上游仓库、当前版本、同步命令，以及**为什么不能直接用宿主自带的技能**。
