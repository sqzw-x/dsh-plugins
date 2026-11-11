---
'dsh-notes-context': patch
---

**边界摘要改为整本投影，取消滚动后的笔记补发。** `notebookSummaryMaxChars` 默认值从 2048 字符改为与 `maxNotebookBytes` 相同的 16384——写入端本就不会接受更长的笔记，所以默认配置下 checkpoint 里的笔记就是全文，不再截断。原先的 2048 字符投影只是被压缩历史的一小部分（默认配置下：约 738 token 对约 43 万 token 的被遮蔽区间），截断没有换到任何东西，却让滚动后的模型只看到笔记的前 2048 字符。

同时删除 `agent/pre-step` 里的笔记补发（repair）：它存在的唯一理由是“checkpoint 只带截断投影，所以滚动后要重新摆一遍全文”。checkpoint 带全文之后，补发只会让同一段文本在一次请求里出现两遍。被滚动遮蔽的笔记仍可用 `context_notes` 读到全文。

副作用只有一处，且落在本来就不可用的区间：父级的拒收门槛（摘要必须小于被遮蔽区间）对应的 `messageBudgetTokens` 窄带上界从约 78,896 抬到约 83,163，仍然远低于任何正常窗口。`TRUNCATION_NOTE` 的指向改为 `context_notes`（原来写的是 `context_history`，正确工具是前者），供把上限调低的 profile 使用。
