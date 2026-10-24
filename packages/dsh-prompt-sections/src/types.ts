/**
 * The data model this plugin persists.
 *
 * ## One source of truth
 *
 * Everything the model sees comes from one JSON file (`state.json` under
 * `$DSH_HOME/prompt-sections/`). The profile row's `config` only carries
 * deployment-level switches (master switch, file override, soft size cap) — never
 * prompt text — so there is exactly one place a section can be edited, and the
 * Web editor and a hand-edited file cannot disagree.
 *
 * @module dsh-prompt-sections/types
 */

/** Where a section lands inside the assembled system prompt. */
export const POSITIONS = ['head', 'body', 'tail'] as const

/** A placement band, resolved to a concrete `order` at registration time. */
export type Position = (typeof POSITIONS)[number]

/** One user-owned prompt section. */
export interface SectionSpec {
  /** Stable identifier; also part of the registered section name. */
  id: string
  /** Short label shown by the editor and in diagnostics. */
  title: string
  /** The text contributed to the system prompt. */
  text: string
  /** Placement band; ignored when {@link order} is set. */
  position: Position
  /** Explicit `order` override, or `null` to follow {@link position}. */
  order: number | null
  /** Whether this section is contributed at all. */
  enabled: boolean
  /** Whether `{{variable}}` references resolve (false keeps the text literal). */
  interpolate: boolean
}

/** The whole persisted state. */
export interface LayerState {
  /** Store format version; bumped only with a migration. */
  version: 1
  /** Plugin-wide kill switch, editable from the UI. */
  enabled: boolean
  /** Sections in editor order; the array order breaks ties inside one band. */
  sections: SectionSpec[]
}

/** A section id: lowercase alphanumerics and dashes, long enough to be unique. */
export const SECTION_ID: RegExp = /^[a-z0-9][a-z0-9-]{5,39}$/

/** Section-name prefix; also how the preview tells our sections apart. */
export const SECTION_PREFIX: string = 'user:prompt-sections:'

/** Upper bound on a stored section text, in UTF-8 bytes. */
export const MAX_TEXT_BYTES: number = 256 * 1024

/** Upper bound on stored sections; the editor warns instead of silently dropping. */
export const MAX_SECTIONS: number = 32

/** Longest accepted section title. */
export const MAX_TITLE_LENGTH = 80

/** The empty state a fresh install starts from. */
export function emptyState(): LayerState {
  return { version: 1, enabled: true, sections: [] }
}

/** Thrown when a state document cannot be accepted. */
export class StateValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(path === '' ? message : `${path}: ${message}`)
    this.name = 'StateValidationError'
    this.path = path
  }
}

function fail(path: string, message: string): never {
  throw new StateValidationError(path, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  return value
}

function readBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function readPosition(value: unknown, path: string): Position {
  if (value === undefined) return 'tail'
  if (typeof value !== 'string' || !(POSITIONS as readonly string[]).includes(value)) {
    fail(path, `must be one of ${POSITIONS.join(', ')}`)
  }
  return value as Position
}

function readOrder(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number or null')
  return value
}

function readId(value: unknown, path: string): string {
  const id = readString(value, path)
  if (!SECTION_ID.test(id)) fail(path, 'must match [a-z0-9][a-z0-9-]{5,39}')
  return id
}

/**
 * Validate and normalize one stored state document.
 *
 * Unknown keys inside a section are rejected rather than dropped: a section whose
 * field was renamed by a future version must fail loudly instead of silently
 * losing configuration.
 *
 * @param input - the parsed JSON value.
 * @returns a fresh, fully normalized state.
 * @throws StateValidationError when the document is not acceptable.
 */
export function normalizeState(input: unknown): LayerState {
  if (!isRecord(input)) fail('', 'state must be a JSON object')
  const version = input.version ?? 1
  if (version !== 1) fail('version', 'unsupported state version (expected 1)')
  const enabled = readBoolean(input.enabled, 'enabled', true)
  const rawSections = input.sections ?? []
  if (!Array.isArray(rawSections)) fail('sections', 'must be an array')
  if (rawSections.length > MAX_SECTIONS) fail('sections', `holds more than ${MAX_SECTIONS} sections`)

  const seen = new Set<string>()
  const sections = rawSections.map((raw, index) => {
    const path = `sections[${index}]`
    if (!isRecord(raw)) fail(path, 'must be an object')
    for (const key of Object.keys(raw)) {
      if (!['id', 'title', 'text', 'position', 'order', 'enabled', 'interpolate'].includes(key)) {
        fail(`${path}.${key}`, 'unknown field')
      }
    }
    const id = readId(raw.id, `${path}.id`)
    if (seen.has(id)) fail(`${path}.id`, `duplicate section id "${id}"`)
    seen.add(id)
    const title = readString(raw.title ?? '', `${path}.title`).trim().slice(0, MAX_TITLE_LENGTH)
    const text = readString(raw.text ?? '', `${path}.text`)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_TEXT_BYTES) fail(`${path}.text`, `is ${bytes} bytes; the limit is ${MAX_TEXT_BYTES}`)
    return {
      id,
      title: title === '' ? `Section ${index + 1}` : title,
      text,
      position: readPosition(raw.position, `${path}.position`),
      order: readOrder(raw.order, `${path}.order`),
      enabled: readBoolean(raw.enabled, `${path}.enabled`, true),
      interpolate: readBoolean(raw.interpolate, `${path}.interpolate`, false),
    } satisfies SectionSpec
  })

  return { version: 1, enabled, sections }
}
