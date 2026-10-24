/**
 * Placement math: where a section lands in the assembled system prompt.
 *
 * DSH renders sections in ascending `order`, so "append at the end" is a number,
 * not a special case. The numbers below are the host's own bands
 * (`SECTION_ORDERS` in `@deepseek-ai/dsh-system-prompt`), read at runtime where
 * possible so a host upgrade cannot silently move our text in front of the tool
 * guidance:
 *
 * | band   | order                     | lands after                                      |
 * | ------ | ------------------------- | ------------------------------------------------ |
 * | `head` | 10                        | harness identity (-1000) and the persona (0)     |
 * | `body` | 5100                      | every tool section (1000–3100) and the SDK block |
 * | `tail` | host persona-suffix + 300 | the deployment persona suffix (10200) — the last |
 *
 * A section may also carry an explicit `order`, which wins over its band.
 *
 * @module dsh-prompt-sections/orders
 */
import type { LayerState, Position, SectionSpec } from './types.ts'

/** First order inside the `head` band — right after the persona prefix. */
export const HEAD_BASE = 10

/** First order inside the `body` band — after every tool guidance section. */
export const BODY_BASE = 5100

/** Distance kept above the host's own last section. */
export const TAIL_GAP = 300

/** Spacing between two sections of the same band. */
export const SECTION_STEP = 10

/** Fallback for the host's last built-in section order (`DEPLOYMENT_PERSONA_SUFFIX`). */
export const FALLBACK_TAIL_BASE = 10200

/** The band bases resolved once per load. */
export interface OrderBases {
  /** Order of the host's `deployment:persona-suffix` section. */
  tailBase: number
}

/**
 * Resolve the concrete order of one section.
 *
 * @param section - the stored section.
 * @param ordinal - its index among ALL sections of the same band, in editor
 *   order. Disabled and empty entries keep their slot, so switching one off does
 *   not renumber its neighbours.
 * @param bases - the band bases for this load.
 * @returns the order to register.
 */
export function resolveSectionOrder(section: SectionSpec, ordinal: number, bases: OrderBases): number {
  if (section.order !== null) return section.order
  switch (section.position) {
    case 'head':
      return HEAD_BASE + ordinal * SECTION_STEP
    case 'body':
      return BODY_BASE + ordinal * SECTION_STEP
    case 'tail':
      return bases.tailBase + TAIL_GAP + ordinal * SECTION_STEP
  }
}

/**
 * Plan the registrations for one state: which sections are contributed, under
 * which name and at which order.
 *
 * @param state - the stored state.
 * @param bases - the band bases for this load.
 * @param prefix - registered-name prefix (`user:prompt-sections:` by default).
 * @returns one plan per ENABLED, non-empty section, in editor order.
 */
export function planRegistrations(
  state: LayerState,
  bases: OrderBases,
  prefix: string,
): Array<{ section: SectionSpec; name: string; order: number }> {
  if (!state.enabled) return []
  const ordinals: Record<Position, number> = { head: 0, body: 0, tail: 0 }
  const plan: Array<{ section: SectionSpec; name: string; order: number }> = []
  for (const section of state.sections) {
    // The ordinal counts EVERY entry of the band, including the ones that are
    // switched off or empty. Toggling one section therefore does not renumber
    // its neighbours, which would move their text and invalidate that part of
    // the request prefix for no reason.
    const ordinal = ordinals[section.position]++
    // An empty body contributes nothing; registering it would only produce a
    // section the renderer drops anyway.
    if (!section.enabled || section.text.trim() === '') continue
    plan.push({
      section,
      name: `${prefix}${section.id}`,
      order: resolveSectionOrder(section, ordinal, bases),
    })
  }
  return plan
}
