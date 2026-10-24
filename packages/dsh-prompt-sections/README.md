# dsh-prompt-sections

> 给 DeepSeek Harness 的 **system prompt** 加你自己的段落：写在左侧栏的面板里，落到开头 / 中间 / 最末尾，改完下一个请求生效。

[English](#english) | 简体中文

---

## 它解决什么

DSH 每一步都会把 system prompt 按「段落 + order」重新组装。这个插件让你往里加**自己的**段落：

| 你能做的事 | 怎么做 |
|---|---|
| 在提示词最末尾补一段话 | 新建段落 → 位置选「末尾」 |
| 在人格之后、工具说明之前插规则 | 位置选「开头」 |
| 在工具说明之后加工作约定 | 位置选「中间」 |
| 临时关掉某一段 | 段落上的「启用」开关 |
| 看清最终发给模型的是什么 | 「预览当前系统提示词」 |
| 手工/脚本维护 | 直接编辑 `~/.dsh/prompt-sections.json` |

和 `AGENTS.md` 的区别是**优先级来源**：`AGENTS.md` 以 **user 角色消息**注入，信封里明确写着它不覆盖 system 指令；本插件注册的是真正的 `system` 段落，与平台自己的指令同层。

## 安装

```sh
# 本地检出（开发用，link 方式，改完 build 即生效）
dsh plugin --profile web add link:~/projects/dsh-plugins/packages/dsh-prompt-sections

# 发布后
dsh plugin --profile web add dsh-prompt-sections
```

装完**重启一次 DSH**（新 bundle 需要宿主重新引导），左侧栏底部会多出一个「提示词段落」图标（和 Plugins / 任务时间表 / 上下文档同一排），点开就是面板。以后改代码只需 `npm run build` 再刷新页面。

## 三个落点

| 位置 | order | 落在 |
|---|---|---|
| 开头 | `10` | harness 身份（-1000）、persona（0）之后 |
| 中间 | `5100` | 所有工具说明（1000–3100）、SDK 段（5000）之后 |
| 末尾 | 宿主 `deployment:persona-suffix` + 300 | 宿主最后一段之后——即提示词真正的结尾 |

同一落点里按编辑器顺序每段 +10。段位基数是**运行时**从宿主读的（`getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')`），所以宿主升级调了顺序，我们的文字不会被挤到工具说明前面。

需要精确控制时，可在状态文件里给某段写 `order: 12345`，它优先于位置档位。

## 为什么不会被「预设」遮掉

遮蔽按**段落名字**匹配。预设里的 persona 行占用 `deployment:persona-prefix` / `deployment:persona-suffix` 这两个名字，而本插件的段落叫 `user:prompt-sections:<id>`——名字不重合，全局层因此对所有 agent 生效（含子代理、工作流子代理）。

唯一的例外：预设把 persona 设成 `complete: true`（内置 `minimal` 就是），整份提示词只剩那一段，任何追加都会被丢弃。**预览会直接标注这种情况**，不会假装生效。

## 侧栏面板

- 版式跟随宿主自己的全局页面（参考内置「任务时间表」页）：960px 内容列居中、两侧留白随窗口 `clamp(24px, 4vw, 48px)` 自适应、标题 20px/500，macOS 下会额外让开窗口顶部 48px。
- **单栏**：标题 → 段落列表 → 预览自上而下排。编辑区和预览都占满内容列宽，长正文不再被挤在右半边；窄窗口不需要任何重排。
- **常驻保存条**：底部固定显示「已保存 / 有未保存的修改」，并提供「预览 / 撤销修改 / 保存」。列表再长也不用滚回顶部；`⌘S`（macOS）或 `Ctrl+S` 也能保存。
- 每段一张卡片：逐段启停、名称（≤80 字符）、位置（开头 / 中间 / 末尾）、上移 / 下移 / 删除。停用只加「已停用」标记，卡片仍可编辑；启用但正文为空会当场标黄（空段不会被注册）。
- 每段显示字节数、落点提示和「解析 {{变量}}」开关。
- **保存 / 撤销**：改动先暂存在页面里，保存才落盘，不会把半句话写进正在跑的会话。保存成功后，已有的预览会自动刷新。
- **预览当前系统提示词**：调用宿主真实的 `assemble()` + `renderPrompt()`，用表格列出每段的顺序、order、字节数、哪些是本插件的，并给出最后拼出来的全文（可一键复制）。
- **检查结果**：空段、与既有段落重复的行、开启插值后引用了未知变量、超过软上限的段，都会点名。
- 样式只读 `--dsw-*` 主题 token：亮色、暗色和皮肤主题自动跟随，面板还会校验「不写死颜色」。

预览的两条诚实边界（页面里也会写）：

1. 组装时没有具体的 agent scope，所以**与预设绑定的工具段不会出现**、工具数通常显示 0；列表对「落点」仍然是准的。
2. 预览反映的是**已保存**的状态；有未保存修改时页面会提示。

## 状态文件

默认 `~/.dsh/prompt-sections.json`（`$DSH_HOME` 优先），权限 `0600`，原子写入。也可以手工编辑——文件变化会被发现，正文改动下一个请求就生效，结构改动（增删/移动/启停）由监听器重建注册。

```json
{
  "version": 1,
  "enabled": true,
  "sections": [
    {
      "id": "s-abc123",
      "title": "回答风格",
      "text": "始终用简体中文回答，代码与标识符保持原文。",
      "position": "tail",
      "order": null,
      "enabled": true,
      "interpolate": false
    }
  ]
}
```

字段：

| 字段 | 说明 |
|---|---|
| `id` | `[a-z0-9][a-z0-9-]{5,39}`，同时是该段落注册名的一部分 |
| `title` | 编辑器里的显示名（≤80 字符） |
| `text` | 正文，UTF-8 ≤256 KiB |
| `position` | `head` / `body` / `tail` |
| `order` | 数字则覆盖位置档位；`null` 表示跟随位置 |
| `enabled` | 是否注册 |
| `interpolate` | `true` 才解析 `{{model}}` / `{{provider}}`；`false` 原样进入提示词 |

未知字段、重复 id、非法位置都会**拒绝整份文档**并保留旧状态——宁可报错，也不静默丢配置。

## 配置（profile 行）

```yaml
- id: prompt-sections
  name: dsh-prompt-sections
  config:
    enabled: true            # 总开关；false 时什么都不注册
    storeFile: ''            # 覆盖状态文件路径，空 = $DSH_HOME/prompt-sections.json
    maxSectionBytes: 8192    # 单段软上限，只在 UI 里提示，不截断
```

配置里刻意**没有**提示词文本：唯一真源就是那个 JSON 文件，避免「配置里一份、界面里一份」。

## HTTP 面

只有三个路由，同源、仅 JSON：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/dsh-prompt-sections/state` | 读状态、文件路径、已注册段落、宿主段位基数 |
| `POST` | `/dsh-prompt-sections/state` | 校验 + 持久化 + 重建注册 |
| `GET` | `/dsh-prompt-sections/preview` | 真实组装 + 渲染 + 告警 |

防护：`Origin` 与 `Host` 不一致拒绝（403）、写请求必须 `application/json`（415）、请求体上限 512 KiB（413）、非法文档 422。

## 兼容性与限制

- 目标 `@deepseek-ai/*` **0.2.1-rc.2**（cordis 4.0.5 / schemastery 3.18.5 实测）。
- 宿主没有 `webServer`（headless / acp / sdk）时，只有侧栏面板消失，段落注册照常。
- `{{...}}` 是严格插值：开启插值又写了未知变量，请求会在组装阶段失败——所以默认关闭。
- 段落文字属于请求前缀，改动会让之后的缓存前缀失效；把稳定文本放「末尾」，比频繁改「开头」更省。
- 面板占用中间列：切到别的侧栏面板（Plugins / 任务时间表…）就离开本面板，再点回来会重新拉一次状态；没保存的草稿不会跨面板保留。
- 已知边界：预设 `complete: true` 时无法追加；预览看不到 scope 内的工具段。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit（isolatedDeclarations）
npm run build       # tsdown：lib/index.js（宿主）+ lib/client.js（浏览器）
npm test            # node --test，40 项：真实 cordis + 真实 dsh-system-prompt + 路由 + 浏览器半区
```

包结构：

```
src/types.ts      数据模型 + 校验（未知字段拒绝）
src/orders.ts     落点数学 + 注册计划
src/store.ts      文件存储、原子写、变更检测
src/register.ts   向 ctx.systemPrompt 注册段落
src/preview.ts    真实组装 + 渲染 + 告警
src/routes.ts     同源 JSON API
src/index.ts      宿主入口（配置、监听器、路由装配）
src/client.ts     侧栏行 + 面板（仅 react，无宿主客户端包）
```

## English

`dsh-prompt-sections` adds **user-owned system-prompt sections** to DeepSeek Harness. Write text in a left-column sidebar panel, place it at the head, the middle, or the true tail of the assembled prompt, and it applies on the next model step — no restart.

- Host half registers one `ctx.systemPrompt.section()` per enabled entry at `user:prompt-sections:<id>`; global scope, so presets cannot shadow it (except a `complete: true` persona preset, which the preview reports).
- Browser half is a sidebar panel: a row in the shell's own panel list (`sidebar.panellist`) plus its page in the keyed `main` slot, so the shell keeps the button, label, active highlight and collapsed rail.
- The panel is single-column — heading, section cards, preview — with a save bar pinned to the bottom (`⌘S` / `Ctrl+S` works too). Every colour comes from `--dsw-*` tokens, so light, dark and skin themes follow automatically.
- The preview is produced by the host's real `assemble()` + `renderPrompt()`, refreshed after each save, and can be copied whole; checks name empty sections, repeated lines, unknown variables and oversize text.
- One JSON document is the single source of truth; atomic writes, `0600`, change detection, and strict validation (unknown fields are rejected rather than dropped).

MIT.
