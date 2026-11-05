---
'dsh-focus-notify': patch
'dsh-lan-link': patch
'dsh-notes-context': patch
'dsh-system-prompt-insertion': patch
---

**兼容 DSH 0.2.2-rc.1。** 构建与测试基线升级到 `@deepseek-ai/* 0.2.2-rc.1`（cordis 4.1.0 / schemastery 3.19.0），`dsh.compatibility.dshReleases` 补充 `0.2.2-rc.1`，`@deepseek-ai/cordis` peer 范围纳入 4.1.x。四个插件的运行时代码没有行为变化：`dsh-lan-link` 的网关与代理逻辑未改；`dsh-notes-context` 复核后仍用 `session.requestHeader()` 对齐 compaction 后端的 `routedTarget()`。CI 增加 Node 26，覆盖 0.2.2 宿主要求的 Node ≥24.9。
