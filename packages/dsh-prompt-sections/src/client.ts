/**
 * `dsh-prompt-sections` — browser half.
 *
 * ## What this module is
 *
 * A sidebar panel for the sections the host half registers — not a settings
 * page. The shell's own panel family works through two seats that this module
 * fills together:
 *
 * - `sidebar.panellist` gives us a row in the left column (the rail the Plugins,
 *   Schedules, Market and Context entries live in). The shell owns the button,
 *   the label, the tooltip, the active highlight and the collapsed rail; all we
 *   draw is the glyph, at the size and selection state it asks for.
 * - `main` renders the panel body once the row with the same id is selected.
 *   Reserving `conversation` is not our business: any other key receives no
 *   Session binding, so this page works with no session open.
 *
 * Both registrations go through `ctx.slots.inject`, which fires only after the
 * owning shell entry declares the seat, so load order between this package and
 * the shell does not matter.
 *
 * It is loaded as a lazy-CJS factory (`window.__ModuleLoader__.load`) whose id
 * is the package name; `react` comes from the page's module table, and NOTHING
 * else is imported — no harness client package, no component kit. The panel
 * therefore cannot break when an internal client API moves, and it is
 * theme-consistent through `--dsw-alias-*` tokens rather than by copying host
 * components.
 *
 * ## Shape of the page
 *
 * One column, top to bottom: heading, section list, preview. Saving is a
 * persistent action bar pinned to the bottom of the panel, so a long list never
 * hides the primary action. The preview sits below the editor instead of beside
 * it: at a 960px content width two columns forced the prompt text into a third
 * of the window, and the list of assembled sections was clipped. A single
 * column keeps every control at the width the shell gives its own pages.
 *
 * The panel borrows the shell's visual grammar deliberately: a 960px content
 * column behind responsive gutters, 20px/500 page title, 0.5px hairline
 * borders, pill-shaped primary actions, the theme's switch geometry (36×20),
 * focus rings from `--dsw-focus-ring-*`, and hover fills from
 * `--dsw-alias-interactive-*`. Nothing hard-codes a colour: the stylesheet
 * below only reads theme tokens, so light, dark and skin themes all follow.
 *
 * ## Data flow
 *
 * The panel reads and writes the same JSON API the host half serves
 * (`/dsh-prompt-sections/state`, `/preview`). Edits stage locally, so a
 * half-typed rule never reaches a running session; Save commits the whole
 * document at once. Preview calls the host's real `assemble()`+`renderPrompt()`,
 * which is why it can honestly list the host's own sections and flag our text as
 * hidden under a complete-prompt preset. Saving with a preview on screen
 * refreshes the preview, so the two never disagree.
 *
 * @module dsh-prompt-sections/client
 */

/** Locale namespace owned by this panel. */
const NS = 'dsh-prompt-sections'

/** URL prefix served by the host half (kept in sync with `routes.ts`). */
const API = '/dsh-prompt-sections'

/**
 * The one panel id shared by the sidebar row and the `main` occupant.
 *
 * The shell projects the row's label and dispatches `main` by this exact key, so
 * both registrations read it instead of repeating a literal.
 */
const PANEL_ID = 'prompt-sections'

/**
 * Position among the shell's global panel rows.
 *
 * Shipped rows sit at 0 (Plugins), 10 (Schedules) and 20 (Context); 30 keeps
 * this entry after them without claiming a shipped slot.
 */
const PANEL_ORDER = 30

/** Placement bands, mirroring the host's `POSITIONS`. */
const POSITIONS = ['head', 'body', 'tail'] as const

type Position = (typeof POSITIONS)[number]

/** One stored section, mirroring the host's `SectionSpec`. */
interface SectionSpec {
  id: string
  title: string
  text: string
  position: Position
  order: number | null
  enabled: boolean
  interpolate: boolean
}

/** The stored document, mirroring the host's `LayerState`. */
interface LayerState {
  version: 1
  enabled: boolean
  sections: SectionSpec[]
}

/** The `/state` payload. */
interface StatePayload {
  state: LayerState
  path: string
  origin: 'memory' | 'file' | 'missing' | 'unreadable'
  error?: string
  orderBases: { tailBase: number }
  registered: string[]
}

/** One warning from the preview. */
interface PreviewWarning {
  code: string
  sectionId?: string
  params?: Record<string, string | number>
  message: string
}

/** One assembled section from the preview. */
interface PreviewSection {
  name: string
  index: number
  order?: number
  bytes: number
  ours: boolean
  text: string
}

/** The `/preview` payload. */
interface PreviewResult {
  rendered: string
  bytes: number
  sections: PreviewSection[]
  variables: string[]
  warnings: PreviewWarning[]
  complete: boolean
  renderError?: string
}

/** The lazy-CJS factory hands `require` to this module as a parameter. */
declare const require: (id: string) => unknown

/** The slice of React used here (declared structurally: React is not a build dep). */
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  Fragment: unknown
  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  useCallback<T>(callback: T, deps: readonly unknown[]): T
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T
}

/** What a panel slot hands its occupant for the icon seat. */
interface PanelIconProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this panel is the one selected in the main column. */
  active: boolean
}

/** The client services this half needs. */
interface ClientContext {
  effect(factory: () => (() => void) | void, label?: string): unknown
  locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string) => string
  }
  slots: {
    inject(name: string, register: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

/** Copy, in the two languages the harness ships. */
const zh: Record<string, string> = {
  nav: '提示词段落',
  title: '提示词段落',
  description: '写自己的系统提示词文本，放到开头、中间或最末尾。保存后下一个请求生效，不用重启。',
  enabled: '启用',
  enabledHint: '关闭后所有段落都不再进入系统提示词，不必逐段停用。',
  add: '添加段落',
  addFirst: '添加第一个段落',
  save: '保存',
  saving: '保存中…',
  saveHint: '保存到状态文件（{keys}）',
  revert: '撤销修改',
  preview: '预览',
  previewLong: '预览当前系统提示词',
  previewing: '组装中…',
  statusSaved: '已保存',
  statusDirty: '有未保存的修改',
  pathLabel: '状态文件',
  originFile: '来自文件',
  originMissing: '文件尚未创建',
  originMemory: '刚保存',
  originUnreadable: '文件无法读取',
  tailBase: '末尾档位 {order}',
  tailBaseHint: '宿主最后一段的 order；本插件末尾段从它 +300 开始，预览里能看到每段的最终 order。',
  section: '段落',
  sectionsTitle: '段落',
  sectionsSummary: '{count} 段 · 已注册 {registered}',
  sectionTitle: '名称',
  sectionTitleOf: '第 {index} 段名称',
  sectionTextOf: '第 {index} 段正文',
  positionOf: '第 {index} 段位置',
  moveUpNamed: '上移「{title}」',
  moveDownNamed: '下移「{title}」',
  textPlaceholder: '例如：回答前先复述我的目标；不确定的事实先检索再回答；代码注释保持简短。',
  positionHead: '开头',
  positionBody: '中间',
  positionTail: '末尾',
  positionHintHead: '紧跟人格设定，排在计划策略与工具说明之前。',
  positionHintBody: '排在所有工具说明之后、交付物引用之前。',
  positionHintTail: '排在宿主最后一段之后，是提示词真正的结尾。',
  interpolate: '解析 {{变量}}',
  interpolateHint: '关闭时正文原样进入提示词；开启后可引用 {{model}} / {{provider}}，未知变量会让请求失败。',
  removeNamed: '删除「{title}」',
  toggleNamed: '启停「{title}」',
  bytes: '{bytes} 字节',
  bytesShort: '字节',
  orderShort: 'order',
  emptyListTitle: '还没有段落',
  emptyListHint: '写第一段只影响你自己的系统提示词，保存后才进入下一个请求。',
  emptyChip: '正文为空',
  disabledChip: '已停用',
  previewTitle: '当前系统提示词',
  previewSummary: '共 {count} 段，{bytes} 字节',
  previewStale: '预览是已保存的版本；保存后会自动刷新。',
  previewNone: '还没有预览。点下面的「预览」，看看下一次请求真正发出去的完整提示词。',
  warnings: '检查结果',
  noWarnings: '没有发现问题。',
  ours: '本插件',
  variables: '可用变量',
  loading: '加载中…',
  loadFailed: '读取失败',
  retry: '重试',
  saveFailed: '保存失败',
  previewFailed: '预览失败',
  dismiss: '关闭',
  copy: '复制全文',
  copied: '已复制',
  copyFailed: '复制失败',
  copyFailedHint: '浏览器拒绝了剪贴板访问，请手动选择全文。',
  warnEmpty: '「{title}」已启用但正文为空，不会被注册。',
  warnOversize: '「{title}」{bytes} 字节，超过软上限 {cap} 字节。',
  warnDuplicate: '「{title}」里有句子与「{other}」重复。',
  warnUnknownVariable: '「{title}」引用了 {{name}}，当前组装没有可用值（已知：{known}）。',
  warnHidden: '有段落已注册但不在当前组装里——可能当前预设用 complete 段落接管了整份提示词。',
  warnStoreError: '状态文件读取失败，仍在使用上一份内容：{message}',
  warnRenderError: '渲染失败：{message}',
  warnPreviewPartial: '预览未带 agent scope，{names} 这类每-agent 变量按原样显示。',
}

const en: Record<string, string> = {
  nav: 'Prompt sections',
  title: 'Prompt sections',
  description: 'Write your own system-prompt text and place it at the head, the middle, or the very end. Saved text applies on the next request, with no restart.',
  enabled: 'Enabled',
  enabledHint: 'Turning this off keeps every section out of the prompt without disabling them one by one.',
  add: 'Add section',
  addFirst: 'Add the first section',
  save: 'Save',
  saving: 'Saving…',
  saveHint: 'Save to the state file ({keys})',
  revert: 'Discard changes',
  preview: 'Preview',
  previewLong: 'Preview the current prompt',
  previewing: 'Assembling…',
  statusSaved: 'Saved',
  statusDirty: 'Unsaved changes',
  pathLabel: 'State file',
  originFile: 'from file',
  originMissing: 'file not created yet',
  originMemory: 'just saved',
  originUnreadable: 'file unreadable',
  tailBase: 'tail order {order}',
  tailBaseHint: 'The order of the host\'s last section; our tail sections start 300 after it. The preview shows each final order.',
  section: 'Section',
  sectionsTitle: 'Sections',
  sectionsSummary: '{count} total · {registered} registered',
  sectionTitle: 'Name',
  sectionTitleOf: 'Name of section {index}',
  sectionTextOf: 'Body of section {index}',
  positionOf: 'Placement of section {index}',
  moveUpNamed: 'Move "{title}" up',
  moveDownNamed: 'Move "{title}" down',
  textPlaceholder: 'For example: restate my goal before answering; verify uncertain facts before asserting them; keep code comments short.',
  positionHead: 'Head',
  positionBody: 'Middle',
  positionTail: 'Tail',
  positionHintHead: 'Right after the persona, before plan policy and tool guidance.',
  positionHintBody: 'After every tool section, before deliverable references.',
  positionHintTail: 'After the host\'s own last section (persona suffix) — the true end of the prompt.',
  interpolate: 'Resolve {{variables}}',
  interpolateHint: 'Off keeps the body literal; on lets you use {{model}} / {{provider}}, and an unknown name fails the request.',
  removeNamed: 'Remove "{title}"',
  toggleNamed: 'Toggle "{title}"',
  bytes: '{bytes} bytes',
  bytesShort: 'Bytes',
  orderShort: 'order',
  emptyListTitle: 'No sections yet',
  emptyListHint: 'Write the first piece of system prompt that is yours alone; it applies after you save.',
  emptyChip: 'Empty body',
  disabledChip: 'Off',
  previewTitle: 'The current system prompt',
  previewSummary: '{count} sections, {bytes} bytes',
  previewStale: 'The preview shows what is SAVED; it refreshes after you save.',
  previewNone: 'Nothing previewed yet. Use "Preview" below to see the full prompt the next request sends.',
  warnings: 'Checks',
  noWarnings: 'Nothing looks wrong.',
  ours: 'this plugin',
  variables: 'Variables',
  loading: 'Loading…',
  loadFailed: 'Could not load',
  retry: 'Retry',
  saveFailed: 'Could not save',
  previewFailed: 'Could not preview',
  dismiss: 'Dismiss',
  copy: 'Copy all',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  copyFailedHint: 'The browser refused clipboard access; select the text and copy it manually.',
  warnEmpty: '"{title}" is enabled but empty, so it is not registered.',
  warnOversize: '"{title}" is {bytes} bytes, above the {cap}-byte soft cap.',
  warnDuplicate: '"{title}" repeats a line already present in "{other}".',
  warnUnknownVariable: '"{title}" references {{name}}, which has no value in this assembly (known: {known}).',
  warnHidden: 'A section is registered but absent from the current assembly — the active preset may be taking over the whole prompt.',
  warnStoreError: 'The state file could not be read; the previous content is still live: {message}',
  warnRenderError: 'Rendering failed: {message}',
  warnPreviewPartial: 'Previewed without an agent scope, so per-agent variables such as {names} stayed literal.',
}

/** Localize one preview warning, falling back to the host's English message. */
function warningText(t: (key: string) => string, warning: PreviewWarning): string {
  const keys: Record<string, string> = {
    empty: 'warnEmpty',
    oversize: 'warnOversize',
    duplicate: 'warnDuplicate',
    'unknown-variable': 'warnUnknownVariable',
    hidden: 'warnHidden',
    'store-error': 'warnStoreError',
    'render-error': 'warnRenderError',
    'preview-partial': 'warnPreviewPartial',
  }
  const key = keys[warning.code]
  if (key === undefined) return warning.message
  const template = t(key)
  if (template === key) return warning.message
  return format(template, { ...warning.params ?? {}, message: warning.message })
}

/** Fill `{name}` placeholders in a locale string. */
function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-z][a-z0-9]*)\}/gi, (match, key: string) => String(values[key] ?? match))
}

/** Monospace stack for prompt text, following the shell's configured code font. */
const MONO = 'var(--dsh-font-family-code, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace)'

/** UTF-8 size, matching how the host counts section bytes. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** The hint for one placement band. */
function placementHint(t: (key: string) => string, position: Position): string {
  return position === 'head'
    ? t('positionHintHead')
    : position === 'body' ? t('positionHintBody') : t('positionHintTail')
}


/** Human-facing state of the backing file. */
function originLabel(t: (key: string) => string, origin: StatePayload['origin']): string {
  if (origin === 'file') return t('originFile')
  if (origin === 'memory') return t('originMemory')
  if (origin === 'unreadable') return t('originUnreadable')
  return t('originMissing')
}

/** Localize one API error envelope. */
function errorText(body: Record<string, unknown>, fallback: string): string {
  const field = body.error
  if (typeof field === 'string' && field !== '') return `${fallback}: ${field}`
  if (field !== null && typeof field === 'object') {
    const detail = field as { message?: unknown; code?: unknown }
    const text = detail.message ?? detail.code
    if (text !== undefined) return `${fallback}: ${String(text)}`
  }
  return fallback
}

/** Remove a leading localized prefix so a titled card does not repeat itself. */
function withoutPrefix(text: string | undefined, prefix: string): string | undefined {
  if (text === undefined) return undefined
  const lead = `${prefix}: `
  return text.startsWith(lead) ? text.slice(lead.length) : text
}

/** Read a JSON response, tolerating an HTML error page. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, error: { code: `http-${response.status}`, message: text.slice(0, 300) } }
  }
}

/** Make a fresh section id that satisfies the host's `SECTION_ID` pattern. */
function newId(): string {
  return `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The panel stylesheet.
 *
 * One scoped block instead of dozens of inline style objects: hover, focus,
 * `:disabled` and media-query states cannot be expressed inline, and every
 * global panel is judged against the shell's own pages. Every colour comes from
 * a `--dsw-*` token (the accompanying test refuses literals), so a theme or a
 * skin changes the panel without touching it.
 */
export const PANEL_CSS = `
.dps-root {
  --dps-gutter: clamp(24px, 4vw, 48px);
  --dps-content: 960px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.6;
}
.dps-root *, .dps-root *:before, .dps-root *:after { box-sizing: border-box; }
.dps-root button, .dps-root input, .dps-root select, .dps-root textarea { font-family: inherit; }
.dps-root button, .dps-root input, .dps-root select, .dps-root textarea, .dps-root pre { -webkit-app-region: no-drag; }
.dps-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.dps-content { width: 100%; max-width: var(--dps-content); margin: 0 auto; padding: 0 var(--dps-gutter) 36px; }
.dps-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px 24px;
  flex-wrap: wrap;
  padding-top: 28px;
  margin-bottom: 22px;
}
[data-platform='darwin'] .dps-head { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dps-head-main { flex: 1 1 360px; min-width: 0; }
.dps-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; color: var(--dsw-alias-label-primary); }
.dps-subtitle { max-width: 640px; margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dps-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin-top: 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-caption);
}
.dps-meta code {
  max-width: min(100%, 420px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ${MONO};
  font-size: 12px;
}
.dps-origin[data-origin='missing'] { color: var(--dsw-alias-state-warn-label); }
.dps-origin[data-origin='unreadable'] { color: var(--dsw-alias-state-error-primary); }
.dps-head-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dps-master {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  user-select: none;
}
.dps-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .15s, border-color .15s, opacity .15s;
}
.dps-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dps-btn:disabled { opacity: .4; cursor: not-allowed; }
.dps-btn--primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dps-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dps-btn--outline { box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l3); }
.dps-btn--sm { height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px; line-height: 18px; }
.dps-switch {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  transition: background-color .15s;
}
.dps-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dps-switch:disabled { opacity: .5; cursor: default; }
.dps-switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform .12s ease;
}
.dps-switch[aria-checked='false'] .dps-switch-thumb { background: var(--dsw-alias-switch-thumb); }
.dps-switch[aria-checked='true'] .dps-switch-thumb { transform: translateX(16px); }
.dps-root button:focus-visible,
.dps-root select:focus-visible,
.dps-root input[type='checkbox']:focus-visible,
.dps-root pre:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dps-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dps-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dps-banner--error { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.dps-banner--warn { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.dps-banner-icon { flex: none; margin-top: 3px; }
.dps-banner-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dps-banner .dps-btn { flex: none; margin-left: auto; }
.dps-section { margin-top: 26px; }
.dps-section-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.dps-section-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dps-section-meta { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-caption); }
.dps-section-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.dps-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.dps-list-item { display: block; min-width: 0; }
.dps-card {
  padding: 12px 14px 10px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  transition: border-color .15s;
}
.dps-card:hover, .dps-card:focus-within { border-color: var(--dsw-alias-border-l4); }
.dps-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 32px; }
.dps-card-head-main { display: flex; align-items: center; gap: 8px; flex: 1 1 220px; min-width: 0; }
.dps-card-head-side { display: flex; align-items: center; gap: 4px; flex: none; margin-left: auto; }
.dps-title-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 2px;
  border: 0;
  border-bottom: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}
.dps-title-input:hover { border-bottom-color: var(--dsw-alias-border-l3); }
.dps-title-input:focus { outline: none; border-bottom-color: var(--dsw-alias-state-business-primary); }
.dps-title-input::placeholder { color: var(--dsw-alias-label-caption); font-weight: 400; }
.dps-card[data-enabled='false'] .dps-title-input { color: var(--dsw-alias-label-secondary); }
.dps-select-wrap { position: relative; display: inline-flex; align-items: center; flex: none; }
.dps-select {
  height: 28px;
  padding: 0 24px 0 10px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  appearance: none;
}
.dps-select:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dps-caret { position: absolute; right: 8px; top: 50%; width: 12px; height: 12px; transform: translateY(-50%); color: var(--dsw-alias-label-tertiary); pointer-events: none; }
.dps-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: background-color .15s, color .15s;
}
.dps-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dps-icon-btn:disabled { opacity: .3; cursor: default; }
.dps-icon-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.dps-textarea {
  display: block;
  width: 100%;
  min-height: 96px;
  max-height: 360px;
  margin-top: 6px;
  padding: 10px 12px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: ${MONO};
  font-size: 12.5px;
  line-height: 1.7;
  resize: vertical;
  field-sizing: content;
  transition: border-color .15s;
}
.dps-textarea:hover { border-color: var(--dsw-alias-border-l2); }
.dps-textarea:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.dps-textarea::placeholder { color: var(--dsw-alias-label-caption); }
.dps-card-meta { display: flex; align-items: center; gap: 4px 12px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-caption); }
.dps-card-hint { flex: 1 1 220px; min-width: 0; color: var(--dsw-alias-label-tertiary); }
.dps-check { display: inline-flex; align-items: center; gap: 6px; flex: none; margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; cursor: pointer; white-space: nowrap; }
.dps-check input { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.dps-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 20px;
  white-space: nowrap;
}
.dps-chip--warn { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.dps-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 36px 20px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: 16px;
  text-align: center;
}
.dps-empty-glyph { margin-bottom: 6px; color: var(--dsw-alias-label-caption); }
.dps-empty-title { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.dps-empty-hint { margin: 0; max-width: 440px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dps-empty-action { margin-top: 14px; }
.dps-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
}
.dps-panel--idle { padding: 20px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.dps-panel--idle p { margin: 0; }
.dps-note { margin: 0; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dps-note--warn { color: var(--dsw-alias-state-warn-label); }
.dps-subhead { margin: 0; font-size: 12px; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dps-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dps-var {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-family: ${MONO};
  font-size: 11.5px;
}
.dps-checks { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.dps-check-row { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 20px; color: var(--dsw-alias-state-warn-label); }
.dps-check-dot { flex: none; width: 5px; height: 5px; margin-top: 7px; border-radius: 50%; background: currentColor; }
.dps-check-row--ok { color: var(--dsw-alias-state-success-primary); }
.dps-check-row .dps-check-icon { flex: none; margin-top: 4px; }
.dps-table-scroll {
  overflow: hidden;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
}
.dps-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-family: ${MONO}; font-size: 11.5px; }
.dps-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 6px 8px;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-caption);
  font-weight: 500;
  text-align: left;
}
.dps-table td {
  padding: 5px 8px;
  border-bottom: .5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dps-table tr:last-child td { border-bottom: 0; }
.dps-table tr[data-ours='true'] td { color: var(--dsw-alias-label-primary); }
.dps-table .dps-col-index { width: 38px; }
.dps-table .dps-col-order { width: 64px; }
.dps-table .dps-col-bytes { width: 64px; text-align: right; }
.dps-name-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dps-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dps-tag {
  flex: none;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-alias-state-business-primary);
  font-family: var(--dsw-font-family);
  font-size: 10.5px;
  line-height: 18px;
}
.dps-pre {
  margin: 0;
  max-height: 340px;
  overflow: auto;
  padding: 12px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-family: ${MONO};
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dps-footer {
  flex: none;
  padding: 12px 0;
  border-top: .5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-base);
}
.dps-footer-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  max-width: var(--dps-content);
  margin: 0 auto;
  padding: 0 var(--dps-gutter);
}
.dps-status { display: inline-flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dps-status-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.dps-status-dot[data-dirty='true'] { background: var(--dsw-alias-state-warn-primary); }
.dps-footer-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.dps-loading { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dps-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--dsw-alias-border-l3);
  border-top-color: var(--dsw-alias-state-business-primary);
  border-radius: 50%;
  animation: dps-spin .8s linear infinite;
}
@keyframes dps-spin { to { transform: rotate(360deg); } }
.dps-skeleton { height: 118px; margin-top: 12px; border-radius: 16px; background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2)); }
.dps-state { display: flex; align-items: flex-start; gap: 12px; padding: 16px; border: .5px solid var(--dsw-alias-border-l3); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); }
.dps-state-icon { flex: none; margin-top: 1px; color: var(--dsw-alias-state-error-primary); }
.dps-state-body { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-width: 0; }
.dps-state-title { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dps-state-hint { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .dps-head { gap: 12px; }
  .dps-head-actions { width: 100%; }
}
@media (max-width: 560px) {
  .dps-card { padding: 10px 12px 8px; }
  .dps-card-head-main { flex-basis: 100%; }
  .dps-card-head-side { margin-left: 0; }
  .dps-check { margin-left: 0; }
  .dps-meta code { max-width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dps-spinner { animation: none; }
  .dps-card, .dps-btn, .dps-switch, .dps-switch-thumb, .dps-icon-btn { transition: none; }
}
`

/** Glyphs the panel draws itself; the shell only owns the sidebar row icon. */
type GlyphName = 'up' | 'down' | 'trash' | 'warning' | 'check' | 'close' | 'copy' | 'sections'

/**
 * One 16×16 stroke glyph.
 *
 * @param h - React's createElement.
 * @param name - which path set to draw.
 * @param size - rendered square edge.
 * @returns the SVG element.
 */
function glyph(h: ReactLike['createElement'], name: GlyphName, size = 14): unknown {
  const svg = (children: unknown[]): unknown => h('svg', {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.3',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, ...children)

  switch (name) {
    case 'up':
      return svg([h('path', { d: 'M4 9.5 8 5.5l4 4' })])
    case 'down':
      return svg([h('path', { d: 'M4 6.5 8 10.5l4-4' })])
    case 'trash':
      return svg([
        h('path', { d: 'M3 4.5h10M6.2 4.5V3.3h3.6v1.2M4.6 4.5l.5 8.2h5.8l.5-8.2M6.8 6.8v3.6M9.2 6.8v3.6' }),
      ])
    case 'warning':
      return svg([
        h('path', { d: 'M8 2.2 14 13H2L8 2.2Z' }),
        h('path', { d: 'M8 6.3v3.3M8 11.6v.1' }),
      ])
    case 'check':
      return svg([h('path', { d: 'M3.2 8.4 6.4 11.6 12.8 4.8' })])
    case 'close':
      return svg([h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' })])
    case 'copy':
      return svg([
        h('rect', { x: '5.5', y: '5.5', width: '7', height: '7', rx: '1.2' }),
        h('path', { d: 'M10.5 5.5V3.8a1 1 0 0 0-1-1H4.3a1.5 1.5 0 0 0-1.5 1.5v5.2a1 1 0 0 0 1 1h1.7' }),
      ])
    default:
      return svg([
        h('rect', { x: '2', y: '2.5', width: '12', height: '11', rx: '1.5' }),
        h('path', { d: 'M4.9 6h6.2M4.9 8.4h6.2M4.9 10.8h3.4' }),
      ])
  }
}

/**
 * The sidebar row's glyph.
 *
 * The shell draws the row box, the label, the tooltip and the collapsed rail,
 * then asks this component for a `size`-square, `currentColor` glyph; `active`
 * is the shell's selection state and the shell already paints it, so the glyph
 * stays decorative. `data-dsh-panel-entry` marks the only DOM this plugin owns
 * inside that row, which is how skins and diagnostics identify the entry.
 *
 * @param props - the shell's icon share: square edge and selection state.
 * @returns the decorative section-list glyph.
 */
function PanelIcon(props: PanelIconProps): unknown {
  const React = require('react') as ReactLike
  const h = React.createElement
  return h('svg', {
    'data-dsh-panel-entry': PANEL_ID,
    viewBox: '0 0 16 16',
    width: props.size,
    height: props.size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.3',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
  h('rect', { x: '2', y: '2.5', width: '12', height: '11', rx: '1.5' }),
  h('path', { d: 'M4.9 6h6.2M4.9 8.4h6.2M4.9 10.8h3.4' }),
  )
}

/** The shell's switch geometry, drawn from theme tokens. */
function Switch(props: {
  checked: boolean
  label: string
  title?: string
  disabled?: boolean
  onChange: (next: boolean) => void
}): unknown {
  const React = require('react') as ReactLike
  const h = React.createElement
  return h('button', {
    type: 'button',
    role: 'switch',
    className: 'dps-switch',
    'aria-checked': props.checked,
    'aria-label': props.label,
    ...props.title === undefined ? {} : { title: props.title },
    ...props.disabled === true ? { disabled: true } : {},
    onClick: () => props.onChange(!props.checked),
  }, h('span', { className: 'dps-switch-thumb', 'aria-hidden': 'true' }))
}

/** One section editor card. */
function SectionCard(props: {
  section: SectionSpec
  index: number
  total: number
  autoFocus: boolean
  t: (key: string) => string
  onChange: (next: SectionSpec) => void
  onRemove: () => void
  onMove: (delta: number) => void
}): unknown {
  const React = require('react') as ReactLike
  const h = React.createElement
  const { section, t } = props
  const bytes = byteLength(section.text)
  const hint = placementHint(t, section.position)
  const empty = section.text.trim() === ''

  return h('div', {
    className: 'dps-card',
    'data-enabled': section.enabled ? 'true' : 'false',
    'data-section-id': section.id,
  },
  h('div', { className: 'dps-card-head' },
    h('div', { className: 'dps-card-head-main' },
      h(Switch, {
        checked: section.enabled,
        label: format(t('toggleNamed'), { title: section.title || t('section') }),
        title: section.enabled ? t('enabled') : t('disabledChip'),
        onChange: (next: boolean) => props.onChange({ ...section, enabled: next }),
      }),
      h('input', {
        className: 'dps-title-input',
        value: section.title,
        maxLength: 80,
        autoFocus: props.autoFocus,
        placeholder: t('sectionTitle'),
        'aria-label': format(t('sectionTitleOf'), { index: props.index + 1 }),
        onChange: (event: { target: { value: string } }) => props.onChange({ ...section, title: event.target.value }),
      }),
    ),
    h('div', { className: 'dps-card-head-side' },
      h('span', { className: 'dps-select-wrap' },
        h('select', {
          className: 'dps-select',
          value: section.position,
          title: hint,
          'aria-label': format(t('positionOf'), { index: props.index + 1 }),
          onChange: (event: { target: { value: string } }) => props.onChange({ ...section, position: event.target.value as Position }),
        },
        h('option', { value: 'head' }, t('positionHead')),
        h('option', { value: 'body' }, t('positionBody')),
        h('option', { value: 'tail' }, t('positionTail')),
        ),
        h('svg', { className: 'dps-caret', viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
          h('path', { d: 'M3 4.6 6 7.6 9 4.6' })),
      ),
      h('button', {
        type: 'button',
        className: 'dps-icon-btn',
        title: format(t('moveUpNamed'), { title: section.title || t('section') }),
        'aria-label': format(t('moveUpNamed'), { title: section.title || t('section') }),
        disabled: props.index === 0,
        onClick: () => props.onMove(-1),
      }, glyph(h, 'up', 15)),
      h('button', {
        type: 'button',
        className: 'dps-icon-btn',
        title: format(t('moveDownNamed'), { title: section.title || t('section') }),
        'aria-label': format(t('moveDownNamed'), { title: section.title || t('section') }),
        disabled: props.index === props.total - 1,
        onClick: () => props.onMove(1),
      }, glyph(h, 'down', 15)),
      h('button', {
        type: 'button',
        className: 'dps-icon-btn dps-icon-btn--danger',
        title: format(t('removeNamed'), { title: section.title || t('section') }),
        'aria-label': format(t('removeNamed'), { title: section.title || t('section') }),
        onClick: props.onRemove,
      }, glyph(h, 'trash', 15)),
    ),
  ),
  h('textarea', {
    className: 'dps-textarea',
    value: section.text,
    rows: Math.min(18, Math.max(5, section.text.split('\n').length + 2)),
    placeholder: t('textPlaceholder'),
    'aria-label': format(t('sectionTextOf'), { index: props.index + 1 }),
    spellCheck: false,
    onChange: (event: { target: { value: string } }) => props.onChange({ ...section, text: event.target.value }),
  }),
  h('div', { className: 'dps-card-meta' },
    h('span', null, format(t('bytes'), { bytes })),
    h('span', { className: 'dps-card-hint' }, hint),
    section.enabled
      ? (empty ? h('span', { className: 'dps-chip dps-chip--warn' }, t('emptyChip')) : null)
      : h('span', { className: 'dps-chip' }, t('disabledChip')),
    h('label', { className: 'dps-check', title: t('interpolateHint') },
      h('input', {
        type: 'checkbox',
        checked: section.interpolate,
        onChange: (event: { target: { checked: boolean } }) => props.onChange({ ...section, interpolate: event.target.checked }),
      }),
      t('interpolate'),
    ),
  ),
  )
}

/** The section list, including its empty state. */
function SectionList(props: {
  sections: SectionSpec[]
  justAdded: string | undefined
  t: (key: string) => string
  onAdd: () => void
  onChange: (index: number, next: SectionSpec) => void
  onRemove: (index: number) => void
  onMove: (index: number, delta: number) => void
}): unknown {
  const React = require('react') as ReactLike
  const h = React.createElement
  const { sections, t } = props

  if (sections.length === 0) {
    return h('div', { className: 'dps-empty' },
      h('span', { className: 'dps-empty-glyph' }, glyph(h, 'sections', 28)),
      h('p', { className: 'dps-empty-title' }, t('emptyListTitle')),
      h('p', { className: 'dps-empty-hint' }, t('emptyListHint')),
      h('div', { className: 'dps-empty-action' },
        h('button', { type: 'button', className: 'dps-btn dps-btn--primary', onClick: props.onAdd }, `＋ ${t('addFirst')}`),
      ),
    )
  }

  return h('ol', { className: 'dps-list' }, sections.map((section, index) => h('li', {
    key: section.id,
    className: 'dps-list-item',
  }, h(SectionCard, {
    section,
    index,
    total: sections.length,
    autoFocus: section.id === props.justAdded,
    t,
    onChange: (next: SectionSpec) => props.onChange(index, next),
    onRemove: () => props.onRemove(index),
    onMove: (delta: number) => props.onMove(index, delta),
  }))))
}

/** The assembled-prompt preview, below the editor in the same column. */
export function PreviewPanel(props: {
  preview: PreviewResult | undefined
  previewError: string | undefined
  dirty: boolean
  copying: 'idle' | 'copied' | 'failed'
  t: (key: string) => string
  onCopy: () => void
  onRetry: () => void
}): unknown {
  const React = require('react') as ReactLike
  const h = React.createElement
  const { preview, t } = props
  const copyLabel = props.copying === 'copied' ? t('copied') : props.copying === 'failed' ? t('copyFailed') : t('copy')
  const copyGlyph: GlyphName = props.copying === 'copied' ? 'check' : props.copying === 'failed' ? 'warning' : 'copy'

  return h(React.Fragment, null,
    h('div', { className: 'dps-section-head', id: 'dsh-prompt-sections-preview' },
      h('h2', { className: 'dps-section-title' }, t('previewTitle')),
      preview === undefined
        ? null
        : h('span', { className: 'dps-section-meta' }, format(t('previewSummary'), { count: preview.sections.length, bytes: preview.bytes })),
      preview === undefined
        ? null
        : h('div', { className: 'dps-section-actions' },
          h('button', {
            type: 'button',
            className: 'dps-btn dps-btn--sm',
            onClick: props.onCopy,
            disabled: preview.rendered === '',
            title: props.copying === 'failed' ? t('copyFailedHint') : t('copy'),
          }, glyph(h, copyGlyph, 12), copyLabel),
        ),
    ),
    props.previewError === undefined
      ? null
      : h('div', { className: 'dps-banner dps-banner--error', role: 'alert' },
        h('span', { className: 'dps-banner-icon' }, glyph(h, 'warning')),
        h('div', { className: 'dps-banner-text' }, props.previewError),
        h('button', { type: 'button', className: 'dps-btn dps-btn--sm', onClick: props.onRetry }, t('retry')),
      ),
    preview === undefined
      ? (props.previewError === undefined
        ? h('div', { className: 'dps-panel dps-panel--idle' }, h('p', null, t('previewNone')))
        : null)
      : h('div', { className: 'dps-panel' },
        props.dirty ? h('p', { className: 'dps-note dps-note--warn' }, t('previewStale')) : null,
        h('div', { className: 'dps-inline' },
          h('span', null, t('variables')),
          preview.variables.length === 0
            ? h('span', null, '—')
            : preview.variables.map((name) => h('code', { key: name, className: 'dps-var' }, name)),
        ),
        h('div', null,
          h('h3', { className: 'dps-subhead' }, t('warnings')),
          preview.warnings.length === 0
            ? h('div', { className: 'dps-check-row dps-check-row--ok' },
              h('span', { className: 'dps-check-icon' }, glyph(h, 'check', 12)),
              h('span', null, t('noWarnings')),
            )
            : h('ul', { className: 'dps-checks' }, preview.warnings.map((warning, index) => h('li', {
              key: `${warning.code}-${warning.sectionId ?? index}`,
              className: 'dps-check-row',
            },
            h('span', { className: 'dps-check-dot', 'aria-hidden': 'true' }),
            h('span', null, warningText(t, warning)),
            ))),
        ),
        h('div', { className: 'dps-table-scroll' },
          h('table', { className: 'dps-table' },
            h('thead', null,
              h('tr', null,
                h('th', { scope: 'col', className: 'dps-col-index' }, '#'),
                h('th', { scope: 'col', className: 'dps-col-order' }, t('orderShort')),
                h('th', { scope: 'col' }, t('section')),
                h('th', { scope: 'col', className: 'dps-col-bytes' }, t('bytesShort')),
              ),
            ),
            h('tbody', null, preview.sections.map((section) => h('tr', {
              key: `${section.name}-${section.index}`,
              'data-ours': section.ours ? 'true' : 'false',
            },
            h('td', null, String(section.index + 1).padStart(2, '0')),
            h('td', null, section.order === undefined ? '—' : String(section.order)),
            h('td', null,
              h('span', { className: 'dps-name-cell' },
                h('span', { className: 'dps-name' }, section.name),
                section.ours ? h('span', { className: 'dps-tag' }, t('ours')) : null,
              ),
            ),
            h('td', { className: 'dps-col-bytes' }, `${section.bytes}B`),
            ))),
          ),
        ),
        h('pre', { className: 'dps-pre', tabIndex: 0, 'aria-label': t('previewTitle') }, preview.rendered === '' ? '—' : preview.rendered),
      ),
  )
}

/** The sidebar panel body. */
function PromptSectionsPanel(props: { t?: (key: string) => string }): unknown {
  const React = require('react') as ReactLike
  const h = React.createElement
  const t = props.t ?? ((key: string): string => key)
  const darwin = typeof document !== 'undefined' && document.documentElement.dataset.platform === 'darwin'
  const saveKeys = darwin ? '⌘S' : 'Ctrl+S'

  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [payload, setPayload] = React.useState<StatePayload | undefined>(undefined)
  const [draft, setDraft] = React.useState<LayerState | undefined>(undefined)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [saving, setSaving] = React.useState(false)
  const [preview, setPreview] = React.useState<PreviewResult | undefined>(undefined)
  const [previewing, setPreviewing] = React.useState(false)
  const [previewError, setPreviewError] = React.useState<string | undefined>(undefined)
  const [copying, setCopying] = React.useState<'idle' | 'copied' | 'failed'>('idle')
  const [justAdded, setJustAdded] = React.useState<string | undefined>(undefined)

  const adopt = React.useCallback((next: StatePayload) => {
    setPayload(next)
    setDraft(next.state)
    setPhase('ready')
    setError(undefined)
  }, [])

  const refresh = React.useCallback(() => {
    setPhase('loading')
    fetch(`${API}/state`, { headers: { accept: 'application/json' } })
      .then((response) => readJson(response))
      .then((body) => {
        if (body.ok === true) {
          adopt({
            state: body.state as LayerState,
            path: String(body.path ?? ''),
            origin: (body.origin ?? 'missing') as StatePayload['origin'],
            ...typeof body.error === 'string' ? { error: body.error } : {},
            orderBases: (body.orderBases ?? { tailBase: 10200 }) as StatePayload['orderBases'],
            registered: (body.registered ?? []) as string[],
          })
          return
        }
        setPhase('error')
        setError(errorText(body, t('loadFailed')))
      })
      .catch((cause: unknown) => {
        setPhase('error')
        setError(`${t('loadFailed')}: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }, [adopt, t])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  const dirty = draft !== undefined && payload !== undefined && JSON.stringify(draft) !== JSON.stringify(payload.state)

  const revealPreview = React.useCallback(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    const node = document.getElementById('dsh-prompt-sections-preview')
    if (node === null) return
    const rect = node.getBoundingClientRect()
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return
    node.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [])

  const runPreview = React.useCallback((options?: { reveal?: boolean }) => {
    setPreviewing(true)
    setPreviewError(undefined)
    fetch(`${API}/preview`, { headers: { accept: 'application/json' } })
      .then((response) => readJson(response))
      .then((body) => {
        setPreviewing(false)
        if (body.ok === true) {
          setPreview(body as unknown as PreviewResult)
          if (options?.reveal !== false) window.setTimeout(revealPreview, 0)
          return
        }
        setPreviewError(errorText(body, t('previewFailed')))
      })
      .catch((cause: unknown) => {
        setPreviewing(false)
        setPreviewError(`${t('previewFailed')}: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }, [revealPreview, t])

  const save = React.useCallback(() => {
    if (draft === undefined || saving) return
    setSaving(true)
    setError(undefined)
    fetch(`${API}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(draft),
    })
      .then((response) => readJson(response))
      .then((body) => {
        setSaving(false)
        if (body.ok === true) {
          adopt({
            state: body.state as LayerState,
            path: String(body.path ?? ''),
            origin: (body.origin ?? 'memory') as StatePayload['origin'],
            orderBases: (body.orderBases ?? { tailBase: 10200 }) as StatePayload['orderBases'],
            registered: (body.registered ?? []) as string[],
          })
          // The preview is the saved document by definition; refresh it rather
          // than leave stale text beside freshly saved sections.
          if (preview !== undefined) runPreview({ reveal: false })
          return
        }
        setError(errorText(body, t('saveFailed')))
      })
      .catch((cause: unknown) => {
        setSaving(false)
        setError(`${t('saveFailed')}: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }, [adopt, draft, preview, runPreview, saving, t])

  // Cmd/Ctrl+S saves the staged document, like every other editor on the desktop.
  React.useEffect(() => {
    if (!dirty) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      // A shell dialog owns the keyboard while it is open; do not save behind it.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return
      event.preventDefault()
      save()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [dirty, save])

  const updateSection = React.useCallback((index: number, next: SectionSpec) => {
    setDraft((current) => {
      if (current === undefined) return current
      const sections = [...current.sections]
      sections[index] = next
      return { ...current, sections }
    })
  }, [])

  const removeSection = React.useCallback((index: number) => {
    setDraft((current) => current === undefined
      ? current
      : { ...current, sections: current.sections.filter((_, position) => position !== index) })
  }, [])

  const moveSection = React.useCallback((index: number, delta: number) => {
    setDraft((current) => {
      if (current === undefined) return current
      const target = index + delta
      if (target < 0 || target >= current.sections.length) return current
      const sections = [...current.sections]
      const [moved] = sections.splice(index, 1)
      if (moved === undefined) return current
      sections.splice(target, 0, moved)
      return { ...current, sections }
    })
  }, [])

  const addSection = React.useCallback(() => {
    const id = newId()
    setJustAdded(id)
    setDraft((current) => current === undefined
      ? current
      : {
        ...current,
        sections: [...current.sections, {
          id,
          title: `${t('section')} ${current.sections.length + 1}`,
          text: '',
          position: 'tail',
          order: null,
          enabled: true,
          interpolate: false,
        }],
      })
  }, [t])

  const copyRendered = React.useCallback(() => {
    if (preview === undefined) return
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined) {
      setCopying('failed')
      return
    }
    clipboard.writeText(preview.rendered).then(
      () => {
        setCopying('copied')
        window.setTimeout(() => setCopying('idle'), 1600)
      },
      () => setCopying('failed'),
    )
  }, [preview])

  const shell = (content: unknown[], footer?: unknown): unknown => h('div', { className: 'dps-root' },
    h('style', { 'data-dsh-prompt-sections': 'styles' }, PANEL_CSS),
    h('div', { className: 'dps-scroll' },
      h('div', { className: 'dps-content' }, ...content)),
    footer ?? null,
  )

  const heading = (extra?: unknown, actions?: unknown): unknown => h('header', { className: 'dps-head' },
    h('div', { className: 'dps-head-main' },
      h('h1', { className: 'dps-title' }, t('title')),
      h('p', { className: 'dps-subtitle' }, t('description')),
      extra ?? null,
    ),
    actions ?? null,
  )

  if (phase === 'loading') {
    return shell([
      heading(),
      h('div', { className: 'dps-loading', role: 'status' },
        h('span', { className: 'dps-spinner', 'aria-hidden': 'true' }),
        h('span', null, t('loading')),
      ),
      h('div', { className: 'dps-skeleton', 'aria-hidden': 'true' }),
      h('div', { className: 'dps-skeleton', 'aria-hidden': 'true' }),
    ])
  }

  if (phase === 'error' || draft === undefined || payload === undefined) {
    return shell([
      heading(),
      h('div', { className: 'dps-state' },
        h('span', { className: 'dps-state-icon' }, glyph(h, 'warning', 16)),
        h('div', { className: 'dps-state-body' },
          h('p', { className: 'dps-state-title' }, t('loadFailed')),
          h('p', { className: 'dps-state-hint' }, withoutPrefix(error, t('loadFailed')) ?? t('loadFailed')),
        ),
        h('button', { type: 'button', className: 'dps-btn dps-btn--primary', onClick: refresh }, t('retry')),
      ),
    ])
  }

  const origin = originLabel(t, payload.origin)
  const registered = payload.registered.length
  const showStoreWarning = payload.error !== undefined
  const saveHint = format(t('saveHint'), { keys: saveKeys })

  return shell([
    heading(
      h('div', { className: 'dps-meta' },
        h('span', null, `${t('pathLabel')} `, h('code', { title: payload.path }, payload.path)),
        h('span', { className: 'dps-origin', 'data-origin': payload.origin }, origin),
        h('span', { title: t('tailBaseHint') }, format(t('tailBase'), { order: payload.orderBases.tailBase })),
      ),
      h('div', { className: 'dps-head-actions' },
        h('div', { className: 'dps-master', title: t('enabledHint') },
          h('span', null, t('enabled')),
          h(Switch, {
            checked: draft.enabled,
            label: t('enabled'),
            title: t('enabledHint'),
            onChange: (next: boolean) => setDraft({ ...draft, enabled: next }),
          }),
        ),
        h('button', { type: 'button', className: 'dps-btn dps-btn--outline', onClick: addSection }, `＋ ${t('add')}`),
      ),
    ),

    error === undefined ? null : h('div', { className: 'dps-banner dps-banner--error', role: 'alert' },
      h('span', { className: 'dps-banner-icon' }, glyph(h, 'warning')),
      h('div', { className: 'dps-banner-text' }, error),
      h('button', {
        type: 'button',
        className: 'dps-icon-btn',
        'aria-label': t('dismiss'),
        title: t('dismiss'),
        onClick: () => setError(undefined),
      }, glyph(h, 'close')),
    ),

    showStoreWarning
      ? h('div', { className: 'dps-banner dps-banner--warn', role: 'status' },
        h('span', { className: 'dps-banner-icon' }, glyph(h, 'warning')),
        h('div', { className: 'dps-banner-text' }, format(t('warnStoreError'), { message: payload.error ?? '' })),
      )
      : null,

    h('section', { className: 'dps-section' },
      h('div', { className: 'dps-section-head' },
        h('h2', { className: 'dps-section-title' }, t('sectionsTitle')),
        h('span', { className: 'dps-section-meta' }, format(t('sectionsSummary'), { count: draft.sections.length, registered })),
      ),
      h(SectionList, {
        sections: draft.sections,
        justAdded,
        t,
        onAdd: addSection,
        onChange: updateSection,
        onRemove: removeSection,
        onMove: moveSection,
      }),
    ),

    h('section', { className: 'dps-section' },
      h(PreviewPanel, {
        preview,
        previewError,
        dirty,
        copying,
        t,
        onCopy: copyRendered,
        onRetry: () => runPreview({ reveal: true }),
      }),
    ),
  ],
  h('footer', { className: 'dps-footer' },
    h('div', { className: 'dps-footer-inner' },
      h('div', { className: 'dps-status', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dps-status-dot', 'data-dirty': dirty || saving ? 'true' : 'false', 'aria-hidden': 'true' }),
        h('span', null, saving ? t('saving') : dirty ? t('statusDirty') : t('statusSaved')),
      ),
      h('div', { className: 'dps-footer-actions' },
        h('button', {
          type: 'button',
          className: 'dps-btn',
          onClick: () => runPreview({ reveal: true }),
          disabled: previewing,
          title: t('previewLong'),
        }, previewing ? t('previewing') : t('preview')),
        dirty
          ? h('button', { type: 'button', className: 'dps-btn', onClick: () => setDraft(payload.state) }, t('revert'))
          : null,
        h('button', {
          type: 'button',
          className: 'dps-btn dps-btn--primary',
          onClick: save,
          disabled: !dirty || saving,
          title: saveHint,
        }, saving ? t('saving') : t('save')),
      ),
    ),
  ))
}

/** Locale + slot registration. */
export const inject = ['slots', 'locale'] as const

/**
 * Register this package's sidebar row and main-column panel.
 *
 * The two seats are declared by shell plugins, so each registration is wrapped
 * in `ctx.slots.inject`: the callback runs only after the owning entry declares
 * the seat, and a shell that cannot serve the seats leaves the panel simply
 * absent instead of failing boot.
 *
 * @param ctx - the client context carrying `slots` and `locale`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-prompt-sections: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => {
    const offRow = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: PANEL_ORDER,
      // The shell re-reads this thunk on every projection, so the row follows
      // the active locale without re-registering.
      label: () => t('nav'),
    }, PanelIcon))

    const offPanel = ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({ t }),
    }, PromptSectionsPanel))

    return () => {
      offPanel()
      offRow()
    }
  }, 'dsh-prompt-sections: sidebar panel')
}

export { PromptSectionsPanel, PanelIcon, SectionCard, SectionList, Switch, NS, PANEL_ID, PANEL_ORDER, POSITIONS }
