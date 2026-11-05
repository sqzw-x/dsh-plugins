---
'dsh-focus-notify': patch
'dsh-notes-context': patch
---

**npm 上的仓库地址指回单一仓库。** 这两个包上一次发布时还各自对应独立仓库（`sqzw-x/dsh-focus-notify`、`sqzw-x/dsh-notes-context`），仓库合并进 `dsh-plugins` 后已删除，但 npm 上已发布版本的 `repository` 字段仍是旧地址，插件市场因此无法把包挂到收录条目上：条目只能退回从源码安装（要过一次构建授权），也不显示下载量与版本。本次发布把该字段刷新为 `sqzw-x/dsh-plugins`；代码无变化。
