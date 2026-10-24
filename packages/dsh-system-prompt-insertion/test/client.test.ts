import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * A React stand-in: enough shape for the page to build an element tree, without
 * running effects (the first render is the loading state, which is what a panel
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
    useRef: (current) => ({ current }),
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
  assert.equal(loaded.id, 'dsh-system-prompt-insertion')
  return loaded.factory(require)
}

/** A client context good enough to mount the sidebar panel. */
function fakeClientContext() {
  const registered = []
  const dictionaries = []
  const injected = []
  const cleanedUp = []
  return {
    registered,
    dictionaries,
    injected,
    cleanedUp,
    ctx: {
      effect(factory) {
        cleanedUp.push(factory())
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
          return register()
        },
        register(options, component) {
          registered.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

/** The Chinese dictionary, after `apply` has registered it. */
function zhOf(module) {
  const fake = fakeClientContext()
  module.apply(fake.ctx)
  const dict = fake.dictionaries[0].bundles.zh
  return (key) => dict[key] ?? key
}

/** Collect every node in a fake element tree that matches a predicate. */
function findAll(tree, predicate, out = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) findAll(child, predicate, out)
    return out
  }
  if (tree === null || typeof tree !== 'object') return out
  if (predicate(tree)) out.push(tree)
  for (const child of tree.children ?? []) findAll(child, predicate, out)
  return out
}

/** Concatenate every string child below a node. */
function textOf(tree) {
  if (typeof tree === 'string') return tree
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (tree === null || typeof tree !== 'object') return ''
  return (tree.children ?? []).map(textOf).join('')
}

test('the browser bundle registers a sidebar row and the panel it opens', () => {
  const module = loadClient()
  assert.deepEqual(module.inject, ['slots', 'locale'])

  const fake = fakeClientContext()
  module.apply(fake.ctx)

  // Left column row first, then the center-column page it dispatches.
  assert.deepEqual(fake.injected, ['sidebar.panellist', 'main'])
  assert.equal(fake.registered.length, 2)

  const [row, panel] = fake.registered
  assert.equal(row.options.name, 'sidebar.panellist')
  assert.equal(row.options.id, 'system-prompt-insertion')
  assert.equal(row.options.order, 30)
  assert.equal(typeof row.options.label, 'function')
  assert.equal(row.options.label(), 'dsh-system-prompt-insertion.nav')
  // The row draws only the glyph; the shell owns the button.
  assert.equal(typeof row.component, 'function')
  const icon = row.component({ size: 18, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 18)
  assert.equal(icon.props['data-dsh-panel-entry'], 'system-prompt-insertion')

  assert.equal(panel.options.name, 'main')
  assert.equal(panel.options.key, 'system-prompt-insertion')
  assert.equal(typeof panel.options.inject, 'function')
  assert.equal(typeof panel.options.inject().t, 'function')
  assert.equal(typeof panel.component, 'function')

  // One id, two seats: a mismatch would leave the row selecting an empty panel.
  assert.equal(row.options.id, panel.options.key)
})

test('apply registers no settings section', () => {
  const module = loadClient()
  const fake = fakeClientContext()
  module.apply(fake.ctx)
  for (const entry of fake.registered) {
    assert.notEqual(entry.options.name, 'settings.section')
    assert.notEqual(entry.options.name, 'settings.general.item')
  }
})

test('the panel renders its first paint without touching the network', () => {
  const module = loadClient()
  const fake = fakeClientContext()
  module.apply(fake.ctx)
  const panel = fake.registered[1].component
  const tree = panel({ t: (key) => key })
  assert.ok(tree, 'the component returns an element')
  assert.equal(tree.type, 'div')
  // The root owns the whole center column and ships its own scoped stylesheet.
  assert.equal(tree.props.className, 'dspi-root')
  const styles = findAll(tree, (node) => node.type === 'style')
  assert.equal(styles.length, 1)
  assert.equal(styles[0].props['data-dsh-system-prompt-insertion'], 'styles')
  assert.match(textOf(styles[0]), /\.dspi-root/)
  // The loading branch is what a host that never answers shows.
  assert.match(textOf(tree), /loading/)
})

test('both locale dictionaries are registered with the same keys', () => {
  const module = loadClient()
  const fake = fakeClientContext()
  module.apply(fake.ctx)
  assert.equal(fake.dictionaries.length, 1)
  const { ns, bundles } = fake.dictionaries[0]
  assert.equal(ns, 'dsh-system-prompt-insertion')
  const zhKeys = Object.keys(bundles.zh).sort()
  const enKeys = Object.keys(bundles.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length > 20)
})

test('the stylesheet paints only with theme tokens', () => {
  const module = loadClient()
  // A hard-coded colour would survive in light mode and break every skin, so
  // the panel is not allowed to contain one.
  assert.match(module.PANEL_CSS, /--dsw-alias-label-primary/)
  assert.doesNotMatch(module.PANEL_CSS, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(module.PANEL_CSS, /\b(?:rgb|hsl)a?\(/i)
  // The shell's switch geometry, not an invented one.
  assert.match(module.PANEL_CSS, /\.dspi-switch\s*\{[^}]*width: 36px/)
})

test('the switch reports its state and inverts on click', () => {
  const module = loadClient()
  const seen = []
  const button = module.Switch({ checked: true, label: 'enable', onChange: (next) => seen.push(next) })
  assert.equal(button.type, 'button')
  assert.equal(button.props.role, 'switch')
  assert.equal(button.props['aria-checked'], true)
  button.props.onClick()
  assert.deepEqual(seen, [false])
})

test('a section card keeps placement options inside its select', () => {
  const module = loadClient()
  const t = zhOf(module)
  const section = {
    id: 's-test',
    title: '回答风格',
    text: '保持简短。',
    position: 'body',
    order: null,
    enabled: true,
    interpolate: false,
  }
  const card = module.SectionCard({
    section,
    index: 0,
    total: 2,
    autoFocus: false,
    t,
    onChange: () => {},
    onRemove: () => {},
    onMove: () => {},
  })

  assert.equal(card.props.className, 'dspi-card')
  const selects = findAll(card, (node) => node.type === 'select')
  assert.equal(selects.length, 1)
  assert.equal(selects[0].props.value, 'body')
  // Three real options — a staggered option list would render an empty control.
  assert.deepEqual(selects[0].children.map((option) => option.props.value), ['head', 'body', 'tail'])
  assert.deepEqual(selects[0].children.map(textOf), ['开头', '中间', '末尾'])

  // The switch is a component child: assert the props it receives, then the
  // standalone test above covers the button it renders.
  const switches = findAll(card, (node) => node.type === module.Switch)
  assert.equal(switches.length, 1)
  assert.equal(switches[0].props.checked, true)

  const textarea = findAll(card, (node) => node.type === 'textarea')
  assert.equal(textarea[0].props.value, '保持简短。')
  assert.match(textOf(card), /15 字节/)
})

test('a disabled section is labelled, and an enabled empty one warns', () => {
  const module = loadClient()
  const t = zhOf(module)
  const base = { index: 0, total: 1, autoFocus: false, t, onChange: () => {}, onRemove: () => {}, onMove: () => {} }
  const disabled = module.SectionCard({
    ...base,
    section: { id: 's-a', title: 'a', text: '正文', position: 'tail', order: null, enabled: false, interpolate: false },
  })
  const disabledChip = findAll(disabled, (node) => node.props.className === 'dspi-chip')
  assert.equal(disabledChip.length, 1)
  assert.equal(textOf(disabledChip[0]), '已停用')

  const empty = module.SectionCard({
    ...base,
    section: { id: 's-b', title: 'b', text: '   ', position: 'head', order: null, enabled: true, interpolate: true },
  })
  const emptyChip = findAll(empty, (node) => node.props.className === 'dspi-chip dspi-chip--warn')
  assert.equal(emptyChip.length, 1)
  assert.equal(textOf(emptyChip[0]), '正文为空')
})

test('the empty list offers the first-section action', () => {
  const module = loadClient()
  const t = zhOf(module)
  const list = module.SectionList({
    sections: [],
    justAdded: undefined,
    t,
    onAdd: () => {},
    onChange: () => {},
    onRemove: () => {},
    onMove: () => {},
  })
  const buttons = findAll(list, (node) => node.type === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(textOf(buttons[0]), '＋ 添加第一个段落')
})

test('the preview lists the assembly, marks our rows and localizes warnings', () => {
  const module = loadClient()
  const t = zhOf(module)
  const preview = {
    rendered: 'hello',
    bytes: 5,
    variables: ['model'],
    complete: false,
    warnings: [{
      code: 'duplicate',
      sectionId: 's-a',
      params: { title: '回答风格', other: 'identity' },
      message: 'raw host message',
    }],
    sections: [
      { name: 'identity', index: 0, bytes: 10, ours: false, text: '' },
      { name: 'user:system-prompt-insertion:s-a', index: 1, order: 10300, bytes: 5, ours: true, text: '' },
    ],
  }
  const panel = module.PreviewPanel({
    preview,
    previewing: false,
    previewError: undefined,
    dirty: true,
    copying: 'idle',
    t,
    onCopy: () => {},
    onRefresh: () => {},
  })
  const table = findAll(panel, (node) => node.type === 'table')
  assert.equal(table.length, 1)
  const rows = findAll(table[0], (node) => node.type === 'tr')
  assert.equal(rows.length, 3, 'one header row plus one row per section')
  assert.match(textOf(table[0]), /本插件/)
  assert.match(textOf(table[0]), /10300/)
  assert.match(textOf(panel), /「回答风格」有一行与「identity」重复。/)
  assert.match(textOf(panel), /预览是已保存的版本/)
})

test('the preview header offers a refresh action and a loading state', () => {
  const module = loadClient()
  const t = zhOf(module)
  let refreshes = 0
  const panel = module.PreviewPanel({
    preview: undefined,
    previewing: true,
    previewError: undefined,
    dirty: false,
    copying: 'idle',
    t,
    onCopy: () => {},
    onRefresh: () => { refreshes++ },
  })
  const buttons = findAll(panel, (node) => node.type === 'button')
  const refresh = buttons.find((node) => node.props.className === 'dspi-icon-btn dspi-preview-refresh')
  assert.ok(refresh, 'the preview heading carries a refresh button')
  assert.equal(refresh.props['aria-label'], '刷新预览')
  assert.equal(refresh.props.disabled, true)
  refresh.props.onClick()
  assert.equal(refreshes, 1)
  assert.match(textOf(panel), /组装中/)
})

test('a failed preview shows the error instead of an empty-preview note', () => {
  const module = loadClient()
  const t = zhOf(module)
  const panel = module.PreviewPanel({
    preview: undefined,
    previewing: false,
    previewError: '预览失败: boom',
    dirty: false,
    copying: 'failed',
    t,
    onCopy: () => {},
    onRefresh: () => {},
  })
  const text = textOf(panel)
  assert.match(text, /预览失败: boom/)
  assert.doesNotMatch(text, /还没有预览/)
})
