---
'dsh-notes-context': minor
---

**`context_history` 支持搜索与作用域过滤。** 之前只能按 `from`/`to` 翻页：模型想找一句原话，只能先读索引、猜区间、再读，每次都是 round-trip。现在加四个参数：

- `query` —— 按事件正文匹配，返回最新匹配，并把每个命中条目渲染成**命中点附近的片段**（每个条目最多三处）。匹配跑在完整正文上，不是被截到 200 字符的摘要，所以落在摘要之后的内容也找得到，且模型看到的就是命中的原文。
- `regex` —— `true` 时把 `query` 当 JavaScript 正则，否则按字面量（元字符已转义）。编译失败会带着引擎的报错直接失败，而不是静默不匹配；上限 200 字符。
- `caseSensitive` —— 默认不区分大小写。
- `scope` —— `all`（默认）/ `user` / `assistant` / `tool_call` / `tool_result`。插件自己的笔记与提醒消息虽然是 user 角色，但不算 `user` 事件，仍可用 `context_notes` 读取。

顺带修掉一个使搜索几乎无用的 bug：`tool/result` 与 `system/message` 的事件负载把消息包在 `message` 字段里（`user/message` 才是消息本身），而渲染器按前者读取，导致**工具输出一直渲染成空正文**——既读不到也搜不到。同一处修正也让 `developer/message` 的正文不再丢失。

读出函数随之改为具名选项对象并导出（`readHistory(session, options, cfg, signal)`），行为未变。
