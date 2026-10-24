import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

import {
  PromptStore,
  SectionRegistrar,
  apply,
  buildPreview,
  emptyState,
  planRegistrations,
} from '../lib/index.js'

/** Let a cordis plugin's init settle (plugin mounting is synchronous, effects are not). */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

/** One section document used across the cases. */
function section(overrides) {
  return {
    id: 's-abcdef',
    title: 'Rules',
    text: 'ANSWER-IN-CHINESE',
    position: 'tail',
    order: null,
    enabled: true,
    interpolate: false,
    ...overrides,
  }
}

/**
 * A host with the real prompt registry mounted and the plugin applied through a
 * disposable child fiber, so the file watcher is torn down with the test.
 */
async function withHost(t, sections) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-sections-'))
  const file = join(dir, 'state.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const ctx = new Context()
  ctx.plugin(SystemPrompt, { personaPrefix: 'PERSONA', includeRuntimeContext: false })
  await tick()

  const seed = { version: 1, enabled: true, sections }
  writeFileSync(file, JSON.stringify(seed), 'utf8')

  const fiber = ctx.plugin({
    name: 'prompt-sections-under-test',
    inject: ['systemPrompt'],
    apply: (child) => apply(child, { enabled: true, storeFile: file, maxSectionBytes: 8192 }),
  })
  await tick()
  t.after(async () => {
    await fiber.dispose()
  })

  const assemble = async () => {
    const assembly = await ctx.systemPrompt.assemble({})
    return { assembly, rendered: renderPrompt(assembly) }
  }
  return { ctx, file, dir, assemble }
}

test('a tail section renders after every host section', async (t) => {
  const { assemble } = await withHost(t, [section({})])
  const { assembly, rendered } = await assemble()
  assert.ok(rendered.endsWith('ANSWER-IN-CHINESE'), rendered)
  const names = assembly.sections.map((entry) => entry.name)
  assert.equal(names.at(-1), 'user:prompt-sections:s-abcdef')
  // The deployment persona suffix (10200) is the host's own last section.
  const order = assembly.sections.findIndex((entry) => entry.name === 'deployment:persona-suffix')
  assert.ok(order >= 0)
  assert.equal(names.indexOf('user:prompt-sections:s-abcdef'), names.length - 1)
})

test('a head section lands after the persona and before the tail', async (t) => {
  const { assemble } = await withHost(t, [
    section({ id: 's-aaaaaa', position: 'head', text: 'HEAD-TEXT' }),
    section({ id: 's-bbbbbb', position: 'tail', text: 'TAIL-TEXT' }),
  ])
  const { assembly } = await assemble()
  const names = assembly.sections.map((entry) => entry.name)
  assert.ok(names.indexOf('deployment:persona-prefix') < names.indexOf('user:prompt-sections:s-aaaaaa'))
  assert.ok(names.indexOf('user:prompt-sections:s-aaaaaa') < names.indexOf('user:prompt-sections:s-bbbbbb'))
})

test('disabled and empty sections are not registered', async (t) => {
  const { assemble } = await withHost(t, [
    section({ id: 's-aaaaaa', text: 'VISIBLE' }),
    section({ id: 's-bbbbbb', text: 'HIDDEN', enabled: false }),
    section({ id: 's-cccccc', text: '   ' }),
  ])
  const { assembly, rendered } = await assemble()
  const names = assembly.sections.map((entry) => entry.name)
  assert.deepEqual(names.filter((name) => name.startsWith('user:prompt-sections:')), ['user:prompt-sections:s-aaaaaa'])
  assert.ok(!rendered.includes('HIDDEN'))
})

test('an edited body reaches the next assembly without a remount', async (t) => {
  const { file, assemble } = await withHost(t, [section({ text: 'FIRST-VERSION' })])
  assert.match((await assemble()).rendered, /FIRST-VERSION/)

  writeFileSync(
    file,
    JSON.stringify({ version: 1, enabled: true, sections: [section({ text: 'SECOND-VERSION-LONGER' })] }),
    'utf8',
  )
  const { rendered } = await assemble()
  assert.match(rendered, /SECOND-VERSION-LONGER/)
  assert.ok(!rendered.includes('FIRST-VERSION'))
})

test('an explicit order overrides the band', async (t) => {
  const { assemble } = await withHost(t, [section({ position: 'head', order: 10400, text: 'EXPLICIT-ORDER' })])
  const { assembly } = await assemble()
  // Registered at 10400: after the persona suffix (10200), before our own tail band.
  const names = assembly.sections.map((entry) => entry.name)
  assert.ok(names.indexOf('deployment:persona-suffix') < names.indexOf('user:prompt-sections:s-abcdef'))
})

test('interpolate: false keeps brace groups literal', async (t) => {
  const { assemble } = await withHost(t, [section({ text: 'literal {{model}} braces' })])
  const { rendered } = await assemble()
  assert.match(rendered, /\{\{model\}\}/)
})

test('SectionRegistrar.sync follows structural changes in the store', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-sections-sync-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify(emptyState()), 'utf8')

  const ctx = new Context()
  ctx.plugin(SystemPrompt, { personaPrefix: 'PERSONA', includeRuntimeContext: false })
  await tick()

  const store = new PromptStore({ path: file, logger: ctx.logger })
  const registrar = new SectionRegistrar(ctx, store, ctx.logger)
  registrar.sync()
  assert.equal(registrar.registeredNames().length, 0)

  store.save({ version: 1, enabled: true, sections: [section({ id: 's-aaaaaa', text: 'ADDED-LATER' })] })
  registrar.sync()
  assert.deepEqual(registrar.registeredNames(), ['user:prompt-sections:s-aaaaaa'])

  const assembly = await ctx.systemPrompt.assemble({})
  assert.match(renderPrompt(assembly), /ADDED-LATER/)

  registrar.sync()
  assert.equal(registrar.registeredNames().length, 1, 'sync is idempotent')
  registrar.dispose()
  assert.deepEqual(registrar.registeredNames(), [])
})

test('the preview lists the real assembly and flags our sections', async (t) => {
  const { ctx, assemble } = await withHost(t, [section({ text: 'PREVIEWED-TEXT' })])
  const store = new PromptStore({ path: join(tmpdir(), 'never-written.json'), logger: ctx.logger })
  const registrar = new SectionRegistrar(ctx, store, ctx.logger)
  registrar.sync()

  const preview = await buildPreview({ ctx, store, registrar, maxSectionBytes: 8192 })
  assert.match(preview.rendered, /PREVIEWED-TEXT/)
  assert.ok(preview.sections.some((entry) => entry.ours && entry.name.endsWith('s-abcdef')))
  assert.ok(preview.variables.length >= 0)
  assert.equal(preview.bytes, Buffer.byteLength(preview.rendered, 'utf8'))
  await assemble()
})

test('preview warns about an unknown variable under interpolation', async (t) => {
  const { ctx } = await withHost(t, [section({ text: 'uses {{nope}}', interpolate: true })])
  const store = new PromptStore({ path: join(tmpdir(), 'never-written-2.json'), logger: ctx.logger })
  const registrar = new SectionRegistrar(ctx, store, ctx.logger)
  registrar.sync()

  // The registrar reads the real file, so its state has the section; the preview
  // assembles through the real registry, where {{nope}} is unknown.
  const preview = await buildPreview({ ctx, store, registrar, maxSectionBytes: 8192 })
  assert.ok(preview.warnings.some((warning) => warning.code === 'unknown-variable' || warning.code === 'render-error'))
})

test('a scope-less preview substitutes per-agent variables instead of failing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-sections-scope-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    enabled: true,
    sections: [section({ text: 'USER-TAIL-TEXT' })],
  }), 'utf8')

  const ctx = new Context()
  // The deployment persona references {{model}}, which only the agent loop
  // registers — exactly the scope-less situation the preview has to survive.
  ctx.plugin(SystemPrompt, { personaPrefix: 'powered by {{model}}', includeRuntimeContext: false })
  await tick()

  const store = new PromptStore({ path: file, logger: ctx.logger })
  const registrar = new SectionRegistrar(ctx, store, ctx.logger)
  registrar.sync()

  const preview = await buildPreview({ ctx, store, registrar, maxSectionBytes: 8192 })
  assert.match(preview.rendered, /USER-TAIL-TEXT/)
  assert.match(preview.rendered, /\{\{model\}\}/, 'the unresolved reference stays visible')
  assert.ok(preview.warnings.some((warning) => warning.code === 'preview-partial'))
  assert.ok(!preview.warnings.some((warning) => warning.code === 'render-error'))
  assert.equal(preview.renderError === undefined ? '' : preview.renderError, '')
})

test('planRegistrations keeps disabled slots stable', () => {
  const plan = planRegistrations(
    {
      version: 1,
      enabled: true,
      sections: [
        section({ id: 's-aaaaaa' }),
        section({ id: 's-bbbbbb', enabled: false }),
        section({ id: 's-cccccc' }),
      ],
    },
    { tailBase: 10200 },
    'user:prompt-sections:',
  )
  assert.deepEqual(plan.map((entry) => entry.order), [10500, 10520])
})
