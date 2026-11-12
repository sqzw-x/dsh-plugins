---
'dsh-notes-context': minor
---

**`context_history` 支持搜索与作用域过滤。** 之前只能按 `from`/`to` 翻页：模型想找一句原话，只能先读索引、猜区间、再读，每次都是 round-trip。现在加三个参数：

- `query` —— 按**字面量**匹配事件正文（默认不区分大小写），返回最新匹配，并把每个命中条目渲染成**命中点附近的片段**（每条目最多三处，前后各 60 字符）。匹配跑在完整正文上而不是被截到 200 字符的摘要，所以落在摘要之后的内容也找得到，模型看到的就是命中的原文。
- `caseSensitive` —— 关掉默认的大小写折叠。
- `scope` —— `all`（默认）/ `user` / `assistant` / `tool_call` / `tool_result`，对普通区间读同样生效。插件自己的笔记与提醒消息虽然是 user 角色，但不算 `user` 事件，仍用 `context_notes` 读。

**不提供正则。** 这个扫描是同步的、覆盖每一条工具输出（内容来自不可信来源），而 JS 的回溯引擎对 `(a+)+$` 这类模式在几十个字符上就要跑几分钟——一次调用会挂住整个 host，`AbortSignal` 也插不进去。字面量搜索 + 转义足以回答"那句话在哪"。

结果被上限截断时表头会说明：`2 of 3 matches … (oldest dropped by the entry ceiling and the byte budget)`，不再把截断结果伪装成全部。空 `query` 等同不传；`raw` 与 `query` 互斥、非法 `scope`、`from > to` 都直接报错，而不是静默返回空。

顺带修掉一个使搜索几乎无用的 bug：`tool/result`、`system/message`、`developer/message` 的事件负载把消息包在 `message` 字段里（只有 `user/message` 是消息本身），渲染器却按前者读取，导致**工具输出一直渲染成空正文**——既读不到也搜不到。

读出函数随之改为具名选项对象并导出（`readHistory(session, options, cfg, signal)`）。
