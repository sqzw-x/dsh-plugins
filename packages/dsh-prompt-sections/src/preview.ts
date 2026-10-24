/**
 * The preview: what the model would actually receive, and what is wrong with it.
 *
 * The preview is produced by calling the real `ctx.systemPrompt.assemble()` —
 * never by concatenating our own text — so it shows the host's sections, their
 * real orders and the final rendered string. Two honesty constraints follow from
 * that and are reported rather than papered over:
 *
 *  - Assembly without an agent scope only sees the GLOBAL layer, so a tool
 *    section contributed per preset does not appear and `tools` is usually empty.
 *    The list is still the truth about placement, which is what the editor is for.
 *  - A preset that mounts `dsh-persona` with `complete: true` restores a single
 *    section as the whole prompt. Our sections are registered but not rendered;
 *    the preview reports them as hidden instead of showing text that will not be
 *    sent.
 *
 * @module dsh-prompt-sections/preview
 */
import type { Context } from '@deepseek-ai/cordis'
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { SECTION_PREFIX, type LayerState, type SectionSpec } from './types.ts'
import type { SectionRegistrar } from './register.ts'
import type { PromptStore } from './store.ts'

/** One warning the editor shows above the preview. */
export interface PreviewWarning {
  /** Stable machine code the client localizes. */
  code: 'hidden' | 'duplicate' | 'unknown-variable' | 'oversize' | 'empty' | 'store-error' | 'render-error' | 'preview-partial'
  /** The section the warning is about, when it is about one. */
  sectionId?: string
  /** Values the client interpolates into its own localized copy. */
  params?: Record<string, string | number>
  /** English fallback for a client that does not know this code. */
  message: string
}

/** One section of the assembled prompt. */
export interface PreviewSection {
  /** Registry name. */
  name: string
  /** Zero-based position in the rendered prompt. */
  index: number
  /** The order this plugin registered the section at, when it is ours. */
  order?: number
  /** UTF-8 size of the resolved text. */
  bytes: number
  /** Whether this section came from this plugin. */
  ours: boolean
  /** The resolved (probably interpolated) text. */
  text: string
}

/** Everything the preview panel renders. */
export interface PreviewResult {
  /** The rendered system prompt, or `''` when rendering failed. */
  rendered: string
  /** UTF-8 size of {@link rendered}. */
  bytes: number
  /** The assembly's sections in canonical order. */
  sections: PreviewSection[]
  /** Variables the loop registered for this assembly. */
  variables: string[]
  /** Warnings derived from the state and the assembly. */
  warnings: PreviewWarning[]
  /** Whether an effective complete-prompt section owns the assembly. */
  complete: boolean
  /** Why rendering failed, when it did. */
  renderError?: string
}

/** The subset of host services the preview needs. */
export interface PreviewHost {
  ctx: Context
  store: PromptStore
  registrar: SectionRegistrar
  maxSectionBytes: number
}

/** Normalize a line for duplicate detection: trimmed, whitespace collapsed. */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/** Lines long enough that a repeat is a real repetition rather than boilerplate. */
const DUPLICATE_LINE_FLOOR = 30

/** Complete `{{name}}` references, mirroring the registry's own grammar. */
const VARIABLE_REFERENCE = /\{\{([^{}]*)\}\}/g

/** Lines of one text, indexed for duplicate detection. */
function longLines(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = normalizeLine(raw)
    if (line.length >= DUPLICATE_LINE_FLOOR) lines.push(line)
  }
  return lines
}

/** Warnings that depend only on the stored state. */
function stateWarnings(state: LayerState, maxSectionBytes: number): PreviewWarning[] {
  const warnings: PreviewWarning[] = []
  for (const section of state.sections) {
    const bytes = Buffer.byteLength(section.text, 'utf8')
    if (section.enabled && section.text.trim() === '') {
      warnings.push({
        code: 'empty',
        sectionId: section.id,
        params: { title: section.title },
        message: `"${section.title}" is enabled but empty.`,
      })
    }
    if (bytes > maxSectionBytes) {
      warnings.push({
        code: 'oversize',
        sectionId: section.id,
        params: { title: section.title, bytes, cap: maxSectionBytes },
        message: `"${section.title}" is ${bytes} bytes, above the ${maxSectionBytes}-byte soft cap.`,
      })
    }
  }
  return warnings
}

/** Warnings that compare our text with the rest of the assembled prompt. */
function duplicateWarnings(state: LayerState, assembly: PromptAssembly): PreviewWarning[] {
  const foreign = new Map<string, string>()
  for (const section of assembly.sections) {
    if (section.name.startsWith(SECTION_PREFIX)) continue
    for (const line of longLines(section.text)) {
      if (!foreign.has(line)) foreign.set(line, section.name)
    }
  }
  const warnings: PreviewWarning[] = []
  const reported = new Set<string>()
  for (const section of state.sections) {
    if (!section.enabled) continue
    for (const line of longLines(section.text)) {
      const owner = foreign.get(line)
      if (owner === undefined) continue
      const key = `${section.id}:${owner}`
      if (reported.has(key)) continue
      reported.add(key)
      warnings.push({
        code: 'duplicate',
        sectionId: section.id,
        params: { title: section.title, other: owner },
        message: `"${section.title}" repeats a line already in section "${owner}".`,
      })
    }
  }
  return warnings
}

/** Variables a section references, in first-seen order. */
function referencedVariables(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(VARIABLE_REFERENCE)) {
    const name = match[1] ?? ''
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Warnings about `{{...}}` references that would fail rendering. */
function variableWarnings(state: LayerState, assembly: PromptAssembly): PreviewWarning[] {
  const warnings: PreviewWarning[] = []
  const known = new Set(Object.keys(assembly.variables))
  for (const section of state.sections) {
    if (!section.enabled || !section.interpolate) continue
    for (const name of referencedVariables(section.text)) {
      if (known.has(name) && assembly.variables[name] !== undefined) continue
      warnings.push({
        code: 'unknown-variable',
        sectionId: section.id,
        params: { title: section.title, name, known: [...known].join(', ') || 'none' },
        message: `"${section.title}" references {{${name}}}, which this assembly does not define (known: ${[...known].join(', ') || 'none'}). Turn interpolation off to keep it literal.`,
      })
    }
  }
  return warnings
}

/**
 * Render one assembly the way the harness would, except that a reference with no
 * value stays visible as `{{name}}` instead of throwing.
 *
 * A scope-less assembly legitimately has no `{{model}}`: the loop registers that
 * variable per agent. The preview must still show the prompt, so the missing fact
 * is displayed rather than crashing the panel; {@link buildPreview} reports the
 * substitution separately.
 *
 * @param assembly - the assembled prompt.
 * @returns the rendered text, plus the names left unresolved.
 */
function renderTolerant(assembly: PromptAssembly): { text: string; unresolved: string[] } {
  const unresolved = new Set<string>()
  const variables = assembly.variables
  const parts: string[] = []
  for (const section of assembly.sections) {
    let text = section.text
    if (section.interpolate !== false) {
      text = text.replace(/\{\{([^{}]*)\}\}/g, (match, name: string) => {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) return match
        const value = variables[name]
        if (value === undefined) {
          unresolved.add(name)
          return match
        }
        return value
      })
    }
    if (text.length > 0) parts.push(text)
  }
  return { text: parts.join('\n\n'), unresolved: [...unresolved] }
}

/**
 * Build the preview for the current state.
 *
 * @param host - the store, registrar, host context and soft size cap.
 * @returns the assembled prompt, its sections, and every warning.
 */
export async function buildPreview(host: PreviewHost): Promise<PreviewResult> {
  const state = host.store.current()
  const assembly = await host.ctx.systemPrompt.assemble({})
  const warnings = [...stateWarnings(state, host.maxSectionBytes), ...duplicateWarnings(state, assembly)]
  warnings.push(...variableWarnings(state, assembly))

  const orders = host.registrar.registeredOrders()
  const sections: PreviewSection[] = assembly.sections.map((section, index) => {
    const ours = section.name.startsWith(SECTION_PREFIX)
    const order = ours ? orders.get(section.name) : undefined
    return {
      name: section.name,
      index,
      ...order === undefined ? {} : { order },
      bytes: Buffer.byteLength(section.text, 'utf8'),
      ours,
      text: section.text,
    }
  })

  // A complete-prompt preset restores ONE section; anything else we planned is
  // registered but unreachable, which is worth saying out loud.
  const complete = sections.length === 1 && !sections[0]?.ours
  if (complete) {
    warnings.push({
      code: 'hidden',
      message: 'The active agent preset replaces the whole system prompt with a single section, so these sections are not sent.',
    })
  } else {
    const present = new Set(sections.map((section) => section.name))
    for (const name of host.registrar.registeredNames()) {
      if (present.has(name)) continue
      warnings.push({
        code: 'hidden',
        sectionId: name.slice(SECTION_PREFIX.length),
        message: 'This section is registered but not part of the current global assembly.',
      })
    }
  }

  if (host.store.origin() === 'unreadable') {
    warnings.push({ code: 'store-error', message: host.store.lastError() ?? 'The state file could not be read.' })
  }

  const tolerant = renderTolerant(assembly)
  const rendered = tolerant.text
  let renderError: string | undefined
  try {
    renderPrompt(assembly)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A failure that names one of OUR sections is a real problem the user can
    // fix; anything else is the scope-less assembly missing a per-agent variable,
    // which a real session defines.
    if (message.includes(SECTION_PREFIX)) {
      renderError = message
      warnings.push({ code: 'render-error', message })
    } else {
      warnings.push({
        code: 'preview-partial',
        params: { names: tolerant.unresolved.join(', ') || '—' },
        message: `Previewed without an agent scope, so per-agent variables were left literal (${tolerant.unresolved.join(', ') || 'none'}).`,
      })
    }
  }

  return {
    rendered,
    bytes: Buffer.byteLength(rendered, 'utf8'),
    sections,
    variables: Object.keys(assembly.variables),
    warnings,
    complete,
    ...renderError === undefined ? {} : { renderError },
  }
}
