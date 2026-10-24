/**
 * `dsh-prompt-sections` — browser half.
 *
 * ## What this module is
 *
 * A settings page for the sections the host half registers. It is loaded as a
 * lazy-CJS factory (`window.__ModuleLoader__.load`) whose id is the package name;
 * `react` comes from the page's module table, and NOTHING else is imported — no
 * harness client package, no component kit. The page therefore cannot break when
 * an internal client API moves, and it is theme-consistent through `--dsw-alias-*`
 * tokens rather than by copying host components.
 *
 * ## Data flow
 *
 * The page reads and writes the same JSON API the host half serves
 * (`/dsh-prompt-sections/state`, `/preview`). Edits stage locally, so a half-typed
 * rule never reaches a running session; Save commits the whole document at once.
 * Preview calls the host's real `assemble()`+`renderPrompt()`, which is why it can
 * honestly list the host's own sections and flag our text as hidden under a
 * complete-prompt preset.
 *
 * @module dsh-prompt-sections/client
 */

/** Locale namespace owned by this page. */
const NS = 'dsh-prompt-sections'

/** URL prefix served by the host half (kept in sync with `routes.ts`). */
const API = '/dsh-prompt-sections'

/** The profile row id (unused by the API, kept for diagnostics copy). */
const ENTRY_ID = 'prompt-sections'

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

/** The client services this half needs. */
interface ClientContext {
  effect(factory: () => (() => void) | void, label?: string): unknown
  locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string) => string
  }
  slots: {
    inject(name: string, register: () => () => void): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

/** Copy, in the two languages the harness ships. */
const zh: Record<string, string> = {
  nav: '提示词段落',
  title: '提示词段落',
  description: '写自己的系统提示词文本，放到开头、中间或最末尾。保存后下一个请求生效，不用重启。',
  enabled: '启用',
  add: '添加段落',
  save: '保存',
  saving: '保存中…',
  revert: '撤销修改',
  preview: '预览当前系统提示词',
  previewing: '组装中…',
  dirty: '有未保存的修改',
  clean: '已保存',
  pathLabel: '状态文件',
  registeredLabel: '已注册',
  originFile: '来自文件',
  originMissing: '文件尚未创建',
  originMemory: '刚保存',
  originUnreadable: '文件无法读取',
  sectionCount: '{count} 个段落',
  section: '段落',
  sectionTitle: '名称',
  sectionText: '正文',
  textPlaceholder: '例如：回答前先复述我的目标；不确定的事实先检索再回答；代码注释保持简短。',
  position: '位置',
  positionHead: '开头（人格之后）',
  positionBody: '中间（工具说明之后）',
  positionTail: '末尾（最后一段）',
  positionHintHead: '紧跟 persona，排在计划策略与工具说明之前。',
  positionHintBody: '排在所有工具说明之后、交付物引用之前。',
  positionHintTail: '排在宿主最后一段（persona suffix）之后，是提示词真正的结尾。',
  interpolate: '解析 {{变量}}',
  interpolateHint: '关闭时正文原样进入提示词；开启后可引用 {{model}} / {{provider}}，未知变量会让请求失败。',
  remove: '删除',
  moveUp: '上移',
  moveDown: '下移',
  bytes: '{bytes} 字节',
  emptyList: '还没有段落。点「添加段落」写第一条。',
  emptySection: '正文为空，这个段落不会被注册。',
  previewTitle: '当前系统提示词',
  previewSummary: '共 {count} 段，{bytes} 字节',
  previewStale: '预览反映已保存的状态，先保存再看新内容。',
  previewNone: '还没有预览。',
  warnings: '检查结果',
  noWarnings: '没有发现问题。',
  ours: '本插件',
  order: 'order',
  variables: '可用变量',
  loadFailed: '读取失败',
  saveFailed: '保存失败',
  previewFailed: '预览失败',
  unknownVariable: '未知变量',
  hiddenSection: '未出现在当前组装中',
  baseTail: '宿主末尾段 order',
  close: '关闭',
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
  add: 'Add section',
  save: 'Save',
  saving: 'Saving…',
  revert: 'Discard changes',
  preview: 'Preview the current prompt',
  previewing: 'Assembling…',
  dirty: 'Unsaved changes',
  clean: 'Saved',
  pathLabel: 'State file',
  registeredLabel: 'registered',
  originFile: 'from file',
  originMissing: 'file not created yet',
  originMemory: 'just saved',
  originUnreadable: 'file unreadable',
  sectionCount: '{count} sections',
  section: 'Section',
  sectionTitle: 'Name',
  sectionText: 'Body',
  textPlaceholder: 'For example: restate my goal before answering; verify uncertain facts before asserting them; keep code comments short.',
  position: 'Placement',
  positionHead: 'Head (after the persona)',
  positionBody: 'Middle (after tool guidance)',
  positionTail: 'Tail (the last section)',
  positionHintHead: 'Right after the persona, before plan policy and tool guidance.',
  positionHintBody: 'After every tool section, before deliverable references.',
  positionHintTail: 'After the host\'s own last section (persona suffix) — the true end of the prompt.',
  interpolate: 'Resolve {{variables}}',
  interpolateHint: 'Off keeps the body literal; on lets you use {{model}} / {{provider}}, and an unknown name fails the request.',
  remove: 'Remove',
  moveUp: 'Move up',
  moveDown: 'Move down',
  bytes: '{bytes} bytes',
  emptyList: 'No sections yet. Choose "Add section" to write the first one.',
  emptySection: 'Empty body: this section is not registered.',
  previewTitle: 'The current system prompt',
  previewSummary: '{count} sections, {bytes} bytes',
  previewStale: 'The preview shows what is SAVED. Save first to see new text.',
  previewNone: 'Nothing previewed yet.',
  warnings: 'Checks',
  noWarnings: 'Nothing looks wrong.',
  ours: 'this plugin',
  order: 'order',
  variables: 'Variables',
  loadFailed: 'Could not load',
  saveFailed: 'Could not save',
  previewFailed: 'Could not preview',
  unknownVariable: 'Unknown variable',
  hiddenSection: 'Not part of the current assembly',
  baseTail: 'host tail order',
  close: 'Close',
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
  return template.replace(/\{([a-z]+)\}/gi, (match, key: string) => String(values[key] ?? match))
}

/** Monospace stack for the prompt body. */
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

/** Color tokens, named once so the markup stays readable. */
const C = {
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  labelTertiary: 'var(--dsw-alias-label-tertiary)',
  labelError: 'var(--dsw-alias-label-error)',
  border: 'var(--dsw-alias-border-l2)',
  borderSubtle: 'var(--dsw-alias-border-l1)',
  bg: 'var(--dsw-alias-bg-layer-1)',
  bg2: 'var(--dsw-alias-bg-layer-2)',
  brand: 'var(--dsw-alias-brand-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
} as const

/** Shared button style; `primary` uses the brand fill. */
function buttonStyle(primary: boolean): Record<string, string> {
  return {
    font: 'inherit',
    fontSize: '13px',
    lineHeight: '20px',
    padding: '4px 12px',
    borderRadius: '6px',
    border: primary ? 'none' : `1px solid ${C.border}`,
    background: primary ? C.brand : 'transparent',
    color: primary ? 'var(--dsw-alias-label-primary-foreground)' : C.labelSecondary,
    cursor: 'pointer',
  }
}

/** Small icon-less text button used for reorder/remove. */
function linkStyle(): Record<string, string> {
  return {
    font: 'inherit',
    fontSize: '12px',
    padding: '2px 6px',
    border: 'none',
    background: 'transparent',
    color: C.labelTertiary,
    cursor: 'pointer',
  }
}

/** Make a fresh section id that satisfies the host's `SECTION_ID` pattern. */
function newId(): string {
  return `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
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

/** One section editor card. */
function SectionCard(props: {
  section: SectionSpec
  index: number
  total: number
  t: (key: string) => string
  onChange: (next: SectionSpec) => void
  onRemove: () => void
  onMove: (delta: number) => void
}): unknown {
  const React = require('react') as ReactLike
  const h = React.createElement
  const { section, t } = props
  const bytes = new TextEncoder().encode(section.text).length
  const positionHint = section.position === 'head'
    ? t('positionHintHead')
    : section.position === 'body' ? t('positionHintBody') : t('positionHintTail')

  return h('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '12px',
      borderRadius: '10px',
      border: `1px solid ${C.border}`,
      background: C.bg,
      opacity: section.enabled ? 1 : 0.6,
    },
  },
  h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
    h('input', {
      value: section.title,
      onChange: (event: { target: { value: string } }) => props.onChange({ ...section, title: event.target.value }),
      placeholder: t('sectionTitle'),
      style: {
        flex: '1 1 160px',
        minWidth: 0,
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        color: C.labelPrimary,
        background: 'transparent',
        border: 'none',
        borderBottom: `1px solid ${C.borderSubtle}`,
        padding: '2px 0',
      },
    }),
    h('select', {
      value: section.position,
      onChange: (event: { target: { value: string } }) => props.onChange({ ...section, position: event.target.value as Position }),
      title: positionHint,
      style: {
        font: 'inherit',
        fontSize: '12px',
        color: C.labelSecondary,
        background: C.bg2,
        border: `1px solid ${C.border}`,
        borderRadius: '6px',
        padding: '3px 6px',
      },
    },
    h('option', { value: 'head' }, t('positionHead')),
    h('option', { value: 'body' }, t('positionBody')),
    h('option', { value: 'tail' }, t('positionTail'))),
    h('label', { style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px', color: C.labelSecondary } },
      h('input', {
        type: 'checkbox',
        checked: section.enabled,
        onChange: (event: { target: { checked: boolean } }) => props.onChange({ ...section, enabled: event.target.checked }),
      }),
      t('enabled'),
    ),
    h('div', { style: { display: 'flex', gap: '2px' } },
      h('button', {
        type: 'button',
        title: t('moveUp'),
        onClick: () => props.onMove(-1),
        disabled: props.index === 0,
        style: linkStyle(),
      }, '↑'),
      h('button', {
        type: 'button',
        title: t('moveDown'),
        onClick: () => props.onMove(1),
        disabled: props.index === props.total - 1,
        style: linkStyle(),
      }, '↓'),
      h('button', {
        type: 'button',
        title: t('remove'),
        onClick: props.onRemove,
        style: { ...linkStyle(), color: C.labelError },
      }, '✕'),
    ),
  ),
  h('textarea', {
    value: section.text,
    rows: Math.min(16, Math.max(5, section.text.split('\n').length + 2)),
    placeholder: t('textPlaceholder'),
    onChange: (event: { target: { value: string } }) => props.onChange({ ...section, text: event.target.value }),
    style: {
      width: '100%',
      boxSizing: 'border-box',
      fontFamily: MONO,
      fontSize: '12px',
      lineHeight: '1.6',
      color: C.labelPrimary,
      background: C.bg2,
      border: `1px solid ${C.border}`,
      borderRadius: '8px',
      padding: '8px 10px',
      resize: 'vertical',
    },
  }),
  h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', fontSize: '12px', color: C.labelTertiary, flexWrap: 'wrap' } },
    h('span', null, format(t('bytes'), { bytes })),
    h('span', null, positionHint),
    h('label', { style: { display: 'flex', gap: '4px', alignItems: 'center', marginLeft: 'auto', color: C.labelSecondary } },
      h('input', {
        type: 'checkbox',
        checked: section.interpolate,
        onChange: (event: { target: { checked: boolean } }) => props.onChange({ ...section, interpolate: event.target.checked }),
      }),
      t('interpolate'),
    ),
    section.text.trim() === ''
      ? h('span', { style: { color: C.warn } }, t('emptySection'))
      : null,
  ),
  )
}

/** The settings page. */
function PromptSectionsPage(props: { t?: (key: string) => string }): unknown {
  const React = require('react') as ReactLike
  const h = React.createElement
  const t = props.t ?? ((key: string): string => key)

  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [payload, setPayload] = React.useState<StatePayload | undefined>(undefined)
  const [draft, setDraft] = React.useState<LayerState | undefined>(undefined)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [saving, setSaving] = React.useState(false)
  const [preview, setPreview] = React.useState<PreviewResult | undefined>(undefined)
  const [previewing, setPreviewing] = React.useState(false)
  const [previewError, setPreviewError] = React.useState<string | undefined>(undefined)

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
        setError(format(t('loadFailed'), {}) + `: ${(body.error as { message?: string } | undefined)?.message ?? ''}`)
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

  const save = React.useCallback(() => {
    if (draft === undefined) return
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
          return
        }
        const detail = (body.error as { message?: string; code?: string } | undefined)
        setError(`${t('saveFailed')}: ${detail?.message ?? detail?.code ?? ''}`)
      })
      .catch((cause: unknown) => {
        setSaving(false)
        setError(`${t('saveFailed')}: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }, [adopt, draft, t])

  const runPreview = React.useCallback(() => {
    setPreviewing(true)
    setPreviewError(undefined)
    fetch(`${API}/preview`, { headers: { accept: 'application/json' } })
      .then((response) => readJson(response))
      .then((body) => {
        setPreviewing(false)
        if (body.ok === true) {
          setPreview(body as unknown as PreviewResult)
          return
        }
        setPreviewError(`${t('previewFailed')}: ${(body.error as { message?: string } | undefined)?.message ?? ''}`)
      })
      .catch((cause: unknown) => {
        setPreviewing(false)
        setPreviewError(`${t('previewFailed')}: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }, [t])

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
    setDraft((current) => {
      if (current === undefined) return current
      const section: SectionSpec = {
        id: newId(),
        title: format(t('section'), {}) + ` ${current.sections.length + 1}`,
        text: '',
        position: 'tail',
        order: null,
        enabled: true,
        interpolate: false,
      }
      return { ...current, sections: [...current.sections, section] }
    })
  }, [t])

  if (phase === 'loading') {
    return h('div', { style: { padding: '24px', color: C.labelTertiary, fontSize: '13px' } }, `${t('title')}…`)
  }
  if (phase === 'error' || draft === undefined || payload === undefined) {
    return h('div', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('div', { style: { color: C.labelError, fontSize: '13px' } }, error ?? t('loadFailed')),
      h('button', { type: 'button', onClick: refresh, style: buttonStyle(false) }, t('preview')),
    )
  }

  const enabledSections = draft.sections.filter((section) => section.enabled && section.text.trim() !== '')
  const originLabel = payload.origin === 'file'
    ? t('originFile')
    : payload.origin === 'memory' ? t('originMemory') : payload.origin === 'unreadable' ? t('originUnreadable') : t('originMissing')

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px 24px' } },
    // ── header ──────────────────────────────────────────────────────────────
    h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
      h('div', { style: { flex: '1 1 320px', minWidth: 0 } },
        h('h2', { style: { margin: '0 0 4px', fontSize: '16px', fontWeight: 600, color: C.labelPrimary } }, t('title')),
        h('p', { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: C.labelTertiary } }, t('description')),
      ),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '13px', color: C.labelSecondary } },
          h('input', {
            type: 'checkbox',
            checked: draft.enabled,
            onChange: (event: { target: { checked: boolean } }) => setDraft({ ...draft, enabled: event.target.checked }),
          }),
          t('enabled'),
        ),
        h('button', { type: 'button', onClick: runPreview, disabled: previewing, style: buttonStyle(false) },
          previewing ? t('previewing') : t('preview')),
        h('button', {
          type: 'button',
          onClick: save,
          disabled: !dirty || saving,
          style: { ...buttonStyle(true), opacity: !dirty || saving ? 0.5 : 1 },
        }, saving ? t('saving') : t('save')),
        dirty
          ? h('button', { type: 'button', onClick: () => setDraft(payload.state), style: buttonStyle(false) }, t('revert'))
          : null,
      ),
    ),

    // ── status line ─────────────────────────────────────────────────────────
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px', color: C.labelTertiary } },
      h('span', null, `${t('pathLabel')}: ${payload.path}`),
      h('span', null, `· ${t('registeredLabel')} ${payload.registered.length}/${enabledSections.length}`),
      h('span', null, `· ${originLabel}`),
      h('span', null, `· ${t('baseTail')} ${payload.orderBases.tailBase}`),
      h('span', { style: { color: dirty ? C.warn : C.success } }, dirty ? t('dirty') : t('clean')),
    ),

    error === undefined ? null : h('div', {
      style: {
        borderRadius: '8px',
        border: `1px solid ${C.border}`,
        background: C.bg2,
        padding: '8px 10px',
        fontSize: '12px',
        color: C.labelError,
      },
    }, error),

    // ── sections ────────────────────────────────────────────────────────────
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      draft.sections.length === 0
        ? h('div', { style: { fontSize: '13px', color: C.labelTertiary, padding: '12px 0' } }, t('emptyList'))
        : draft.sections.map((section, index) => h(SectionCard, {
          key: section.id,
          section,
          index,
          total: draft.sections.length,
          t,
          onChange: (next: SectionSpec) => updateSection(index, next),
          onRemove: () => removeSection(index),
          onMove: (delta: number) => moveSection(index, delta),
        })),
      h('div', null,
        h('button', { type: 'button', onClick: addSection, style: buttonStyle(false) }, `＋ ${t('add')}`),
      ),
    ),

    // ── preview ─────────────────────────────────────────────────────────────
    previewError === undefined ? null : h('div', { style: { fontSize: '12px', color: C.labelError } }, previewError),
    preview === undefined ? null : h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        border: `1px solid ${C.border}`,
        borderRadius: '10px',
        padding: '12px',
        background: C.bg2,
      },
    },
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600, color: C.labelPrimary } }, t('previewTitle')),
      h('span', { style: { fontSize: '12px', color: C.labelTertiary } },
        format(t('previewSummary'), { count: preview.sections.length, bytes: preview.bytes })),
      dirty ? h('span', { style: { fontSize: '12px', color: C.warn } }, t('previewStale')) : null,
    ),
    h('div', { style: { fontSize: '12px', color: C.labelTertiary } },
      `${t('variables')}: ${preview.variables.join(', ') || '—'}`),
    preview.warnings.length === 0
      ? h('div', { style: { fontSize: '12px', color: C.success } }, t('noWarnings'))
      : h('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: '12px', color: C.warn, lineHeight: '18px' } },
        preview.warnings.map((warning, index) => h('li', {
          key: `${warning.code}-${warning.sectionId ?? index}`,
        }, warningText(t, warning)))),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '180px', overflow: 'auto' } },
      preview.sections.map((section) => h('div', {
        key: `${section.name}-${section.index}`,
        style: {
          display: 'flex',
          gap: '8px',
          fontSize: '11px',
          fontFamily: MONO,
          color: section.ours ? C.labelPrimary : C.labelTertiary,
        },
      },
      h('span', { style: { minWidth: '42px', textAlign: 'right' } }, String(section.index + 1).padStart(2, '0')),
      h('span', { style: { minWidth: '64px' } }, section.order === undefined ? '—' : String(section.order)),
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, section.name),
      h('span', null, `${section.bytes}B`),
      section.ours ? h('span', { style: { color: C.brand } }, t('ours')) : null,
      )),
    ),
    h('pre', {
      style: {
        margin: 0,
        maxHeight: '320px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: MONO,
        fontSize: '11px',
        lineHeight: '1.6',
        color: C.labelSecondary,
        background: C.bg,
        border: `1px solid ${C.borderSubtle}`,
        borderRadius: '8px',
        padding: '10px',
      },
    }, preview.rendered),
    ),
  )
}

/** Locale + slot registration. */
export const inject = ['slots', 'locale'] as const

/**
 * Register the settings page.
 *
 * @param ctx - the client context carrying `slots` and `locale`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-prompt-sections: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ENTRY_ID,
    order: 60,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, PromptSectionsPage))
}

export { PromptSectionsPage, NS, ENTRY_ID }
