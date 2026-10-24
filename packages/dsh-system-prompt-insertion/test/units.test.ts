import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BODY_BASE,
  HEAD_BASE,
  MAX_SECTIONS,
  StateValidationError,
  emptyState,
  normalizeState,
  planRegistrations,
  resolveSectionOrder,
  resolveOptions,
} from '../lib/index.js'

/** A minimal valid section document. */
function stateWith(sections, enabled = true) {
  return { version: 1, enabled, sections }
}

/** A section with only the fields a test cares about. */
function section(overrides) {
  return {
    id: 's-abcdef',
    title: 'Rules',
    text: 'Be brief.',
    position: 'tail',
    order: null,
    enabled: true,
    interpolate: false,
    ...overrides,
  }
}

test('emptyState is a valid, enabled, empty document', () => {
  const state = emptyState()
  assert.deepEqual(state, { version: 1, enabled: true, sections: [] })
  assert.deepEqual(normalizeState(state), state)
})

test('normalizeState fills defaults and trims titles', () => {
  const normalized = normalizeState(stateWith([section({ title: '   Rules   ', text: 'x' })]))
  assert.equal(normalized.sections[0].title, 'Rules')
  assert.equal(normalized.sections[0].position, 'tail')
  assert.equal(normalized.sections[0].interpolate, false)
  assert.equal(normalized.sections[0].enabled, true)
})

test('normalizeState names an untitled section by its index', () => {
  const normalized = normalizeState(stateWith([section({ title: '   ' })]))
  assert.equal(normalized.sections[0].title, 'Section 1')
})

test('normalizeState rejects duplicate ids', () => {
  assert.throws(
    () => normalizeState(stateWith([section({ id: 's-abcdef' }), section({ id: 's-abcdef' })])),
    (error) => error instanceof StateValidationError && /duplicate section id/.test(error.message),
  )
})

test('normalizeState rejects unknown fields instead of dropping them', () => {
  assert.throws(
    () => normalizeState(stateWith([section({ weight: 3 })])),
    (error) => error instanceof StateValidationError && /unknown field/.test(error.message),
  )
})

test('normalizeState rejects an invalid position and an over-long list', () => {
  assert.throws(() => normalizeState(stateWith([section({ position: 'middle' })])), StateValidationError)
  const many = Array.from({ length: MAX_SECTIONS + 1 }, (_, index) => section({ id: `s-${String(index).padStart(6, '0')}` }))
  assert.throws(() => normalizeState(stateWith(many)), /more than/)
})

test('normalizeState rejects an unsupported version', () => {
  assert.throws(() => normalizeState({ version: 2, enabled: true, sections: [] }), /unsupported state version/)
})

test('resolveSectionOrder follows the band ordinal', () => {
  const bases = { tailBase: 10200 }
  assert.equal(resolveSectionOrder(section({ position: 'head' }), 0, bases), HEAD_BASE)
  assert.equal(resolveSectionOrder(section({ position: 'head' }), 2, bases), HEAD_BASE + 20)
  assert.equal(resolveSectionOrder(section({ position: 'body' }), 0, bases), BODY_BASE)
  assert.equal(resolveSectionOrder(section({ position: 'body' }), 3, bases), BODY_BASE + 30)
  assert.equal(resolveSectionOrder(section({ position: 'tail' }), 0, bases), 10500)
  assert.equal(resolveSectionOrder(section({ position: 'tail' }), 4, bases), 10540)
})

test('resolveSectionOrder lets an explicit order win over the band', () => {
  const bases = { tailBase: 10200 }
  assert.equal(resolveSectionOrder(section({ position: 'head', order: 250 }), 0, bases), 250)
})

test('planRegistrations skips disabled and empty sections and numbers per band', () => {
  const state = stateWith([
    section({ id: 's-aaaaaa', position: 'tail' }),
    section({ id: 's-bbbbbb', position: 'tail', text: '   ' }),
    section({ id: 's-cccccc', position: 'tail', enabled: false }),
    section({ id: 's-dddddd', position: 'tail' }),
    section({ id: 's-eeeeee', position: 'head' }),
  ])
  const plan = planRegistrations(state, { tailBase: 10200 }, 'user:system-prompt-insertion:')
  assert.deepEqual(plan.map((entry) => [entry.name, entry.order]), [
    ['user:system-prompt-insertion:s-aaaaaa', 10500],
    // The empty one still consumed a band slot, so "s-dddddd" does not jump:
    // ordinals count the enabled entries the editor shows.
    ['user:system-prompt-insertion:s-dddddd', 10530],
    ['user:system-prompt-insertion:s-eeeeee', 10],
  ])
})

test('planRegistrations contributes nothing while the plugin is switched off', () => {
  const plan = planRegistrations(stateWith([section({})], false), { tailBase: 10200 }, 'p:')
  assert.deepEqual(plan, [])
})

test('resolveOptions defaults to the harness home and expands an explicit path', () => {
  const fallback = resolveOptions({ enabled: true, storeFile: '', maxSectionBytes: 8192 })
  assert.match(fallback.storeFile, /system-prompt-insertion\.json$/)
  assert.equal(fallback.maxSectionBytes, 8192)

  const explicit = resolveOptions({ enabled: true, storeFile: ' ~/somewhere/state.json ', maxSectionBytes: 0 })
  assert.match(explicit.storeFile, /somewhere\/state\.json$/)
  assert.equal(explicit.maxSectionBytes, 8192)
})
