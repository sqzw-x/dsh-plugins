import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * A React stand-in: enough shape for the page to build an element tree, without
 * running effects (the first render is the loading state, which is what a page
 * that cannot reach the host shows anyway).
 */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    Fragment: Symbol('Fragment'),
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  }
}

/** Load the browser bundle through the module table it targets. */
function loadClient() {
  let loaded
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry
      },
    },
  }
  const react = fakeReact()
  const require = (id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require(${id})`)
  }
  // The bundle is a plain script that calls window.__ModuleLoader__.load(...).
  new Function('window', 'require', bundle)(window, require)
  assert.ok(loaded, 'the bundle registers itself with the module table')
  assert.equal(loaded.id, 'dsh-prompt-sections')
  return loaded.factory(require)
}

/** A client context good enough to mount the settings page. */
function fakeClientContext() {
  const registered = []
  const dictionaries = []
  const injected = []
  return {
    registered,
    dictionaries,
    injected,
    ctx: {
      effect(factory) {
        factory()
        return () => {}
      },
      locale: {
        register(ns, bundles) {
          dictionaries.push({ ns, bundles })
          return () => {}
        },
        bind(ns) {
          return (key) => `${ns}.${key}`
        },
      },
      slots: {
        inject(name, register) {
          injected.push(name)
          register()
        },
        register(options, component) {
          registered.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

test('the browser bundle registers a settings section under its package name', () => {
  const module = loadClient()
  assert.deepEqual(module.inject, ['slots', 'locale'])

  const fake = fakeClientContext()
  module.apply(fake.ctx)

  assert.deepEqual(fake.injected, ['settings.section'])
  assert.equal(fake.registered.length, 1)
  const entry = fake.registered[0]
  assert.equal(entry.options.name, 'settings.section')
  assert.equal(entry.options.id, 'prompt-sections')
  assert.equal(entry.options.locale, 'dsh-prompt-sections')
  assert.equal(typeof entry.options.label, 'function')
  assert.equal(entry.options.label(), 'dsh-prompt-sections.nav')
  assert.equal(typeof entry.component, 'function')
})

test('the page renders its first paint without touching the network', () => {
  const module = loadClient()
  const fake = fakeClientContext()
  module.apply(fake.ctx)
  const component = fake.registered[0].component
  const tree = component({ t: (key) => key })
  assert.ok(tree, 'the component returns an element')
  assert.equal(tree.type, 'div')
})

test('both locale dictionaries are registered with the same keys', () => {
  const module = loadClient()
  const fake = fakeClientContext()
  module.apply(fake.ctx)
  assert.equal(fake.dictionaries.length, 1)
  const { ns, bundles } = fake.dictionaries[0]
  assert.equal(ns, 'dsh-prompt-sections')
  const zhKeys = Object.keys(bundles.zh).sort()
  const enKeys = Object.keys(bundles.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length > 20)
})
