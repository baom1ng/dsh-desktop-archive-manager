/**
 * Render-level tests for the browser half.
 *
 * No React is available outside the app bundle, so these tests drive the real
 * components with a minimal element/hook runtime and a faithful copy of the
 * renderer's own props projection: an inject face's `hooks` object is
 * flattened into `use<Name>` selector hooks (`bindInjectSources` in
 * ui-renderer), plus `t` from the registration's `locale`. Getting that
 * contract wrong is a silent crash inside the slot — exactly what these tests
 * exist to catch.
 *
 * Run with:  node --test test/render.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

function fakeStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (mutate) => {
      mutate(state)
      for (const listener of listeners) listener()
    },
    set: (next) => {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

/** Build one plain element node from a jsx runtime call. */
function element(type, props, key) {
  const children = []
  const rest = { ...(props ?? {}) }
  delete rest.children
  if (props !== undefined && props !== null && props.children !== undefined) {
    children.push(...(Array.isArray(props.children) ? props.children : [props.children]))
  }
  return { type, props: rest, children: children.flat(Infinity), key }
}

/** Flatten one rendered tree into the text a user would read. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  const own = []
  for (const key of ['title', 'description']) {
    if (typeof node.props?.[key] === 'string') own.push(node.props[key])
  }
  return [...own, ...textOf(node.children)]
}

function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (node.type !== undefined) out.push(node)
  collect(node.children, out)
  // Modal-style owners carry their action row and icon as props, not children.
  for (const key of ['footer', 'icon']) collect(node.props?.[key], out)
  return out
}

/** A named stub so assertions can identify which primitive was used. */
function stub(name, props) {
  return element(name, props ?? {})
}

/**
 * The renderer's own projection: `hooks: { archives }` becomes a `useArchives`
 * selector hook prop, the `hooks` key itself is dropped, and `t` is bound when
 * the registration declares a locale namespace.
 */
function flattenFace(face, t) {
  const { hooks, ...rest } = face
  const props = { ...rest }
  if (t !== undefined) props.t = t
  for (const [name, source] of Object.entries(hooks ?? {})) {
    const hookName = `use${String(name[0]).toUpperCase()}${String(name).slice(1)}`
    props[hookName] = (selector = (value) => value) => selector(source.getSnapshot())
  }
  return props
}

/** Load the bundle and hand back its registrations and translators. */
let generation = 0
async function loadBundle() {
  const registrations = new Map()
  let captured
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {} }),
    head: { appendChild: () => {} },
  }
  generation += 1
  await import(`../lib/client.js?render=${String(generation)}`)

  const react = {
    useState: (value) => [value, () => {}],
    useEffect: (fn) => {
      fn()
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    createElement: (type, props, ...children) => element(type, { ...(props ?? {}), children }),
    Fragment: Symbol('Fragment'),
  }
  const primitives = new Proxy({}, {
    get: (target, key) => {
      const name = String(key)
      if (name === 'fileSizeText') return (bytes) => `${String(bytes)}B`
      const component = (props) => stub(name, props)
      Object.defineProperty(component, 'name', { value: name })
      return component
    },
  })
  const require = (specifier) => {
    switch (specifier) {
      case 'react': return react
      case 'react/jsx-runtime':
        return {
          jsx: (type, props, key) => element(type, props, key),
          jsxs: (type, props, key) => element(type, props, key),
        }
      case '@deepseek-ai/dsh-client-ui-primitives': return primitives
      case '@deepseek-ai/dsh-client-store': return { createSnapshotStore: fakeStore }
      default: throw new Error(`unexpected require: ${specifier}`)
    }
  }
  const plugin = captured.factory(require)

  const dictionaries = new Map()
  const translate = (namespace, locale) => (key, params) => {
    const dict = dictionaries.get(namespace)?.[locale] ?? dictionaries.get(namespace)?.zh ?? {}
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/gu, (_match, name) => (params[name] === undefined ? `{${name}}` : String(params[name])))
  }
  const ctx = {
    locale: {
      register: (namespace, dicts) => {
        dictionaries.set(namespace, dicts)
      },
      bind: (namespace) => translate(namespace, 'zh'),
    },
    slots: {
      inject: (_slot, callback) => {
        callback()
      },
      register: (options, component) => {
        registrations.set(`${options.name}:${options.id ?? options.key}`, { options, component })
        return () => {}
      },
    },
    workspaces: {
      list: fakeStore({
        items: [{ workspaceId: 'workspace-1', title: 'alpha', sessionIds: ['session-a'] }],
        archivedSessionIds: ['session-a'],
        pinnedSessionIds: [],
      }),
    },
    sessions: {
      list: fakeStore({
        ids: ['session-a'],
        byId: { 'session-a': { displayTitle: 'Alpha chat' } },
        phase: 'ready',
        projectionsBySession: {},
      }),
      refresh: async () => {},
    },
    uiWorkspace: { unarchiveSession: async () => {} },
    effect: (callback) => {
      callback()
      return () => {}
    },
  }
  plugin.apply(ctx)
  return {
    registrations,
    ctx,
    t: translate('archive-manager', 'zh'),
    tEn: translate('archive-manager', 'en'),
    /** Render one registered component with its real projected props. */
    render(key, extra = {}) {
      const entry = registrations.get(key)
      assert.ok(entry !== undefined, `no registration for ${key}`)
      const face = entry.options.inject === undefined ? {} : entry.options.inject()
      return entry.component({ ...flattenFace(face, translate('archive-manager', 'zh')), ...extra })
    },
  }
}

/** Let pending promises (the model's fetch chain) settle. */
const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

/** A host stub whose list/delete answers the panel and the model consume. */
function stubHost(items = []) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.op === 'list') {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { items, storageRoot: 'C:\\logs' } }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: { results: body.sessionIds.map((sessionId) => ({ sessionId, removed: true, bytes: 2048, files: 2 })), remaining: [] },
      }),
    }
  }
  return calls
}

const ROW_COLD = {
  sessionId: 'session-a',
  present: true,
  bytes: 2048,
  files: 2,
  directory: 'C:\\logs\\session-a',
  createdAt: 1_700_000_000_000,
  workspaceId: 'workspace-1',
  workspaceTitle: 'alpha',
  live: false,
  pendingRestart: false,
}

const ROW_LIVE = {
  sessionId: 'session-live',
  present: false,
  bytes: 0,
  files: 0,
  directory: undefined,
  createdAt: 1_700_000_000_000,
  live: true,
  pendingRestart: true,
}

test('the manager panel renders rows, counts, and the pending-restart badge', async () => {
  stubHost([ROW_COLD, ROW_LIVE])
  const bundle = await loadBundle()
  await settle()
  const tree = bundle.render('main:archive-manager')
  const text = textOf(tree).join(' | ')
  assert.match(text, /归档管理/)
  assert.match(text, /Alpha chat/, 'the title comes from the session catalog the face exposes')
  assert.match(text, /2048B/)
  assert.match(text, /已删除 · 待重启清理/)

  const elements = collect(tree)
  const checkboxes = elements.filter((node) => node.type?.name === 'Checkbox')
  assert.equal(checkboxes.length, 3, 'select-all plus one checkbox per row')
  assert.equal(checkboxes[2].props.disabled, true, 'a pending-restart row cannot be selected')
  const buttons = elements.filter((node) => node.type?.name === 'Button').map((node) => textOf(node.children).join(''))
  assert.ok(buttons.includes('刷新') && buttons.includes('恢复所选') && buttons.includes('删除所选'))
  assert.ok(buttons.includes('恢复') && buttons.includes('删除'), 'the ordinary row keeps its actions')
})

test('every registered component renders without crashing on its projected props', async () => {
  stubHost([ROW_COLD])
  const bundle = await loadBundle()
  await settle()
  for (const key of [
    'main:archive-manager',
    'sidebar.panellist:archive-manager',
    'shell.overlay:archive-manager-confirm',
    'shell.overlay:archive-manager-toast',
  ]) {
    assert.doesNotThrow(() => bundle.render(key), `${key} threw while rendering`)
  }
})

test('an empty archive set renders the empty state with its hint', async () => {
  stubHost([])
  const bundle = await loadBundle()
  await settle()
  const text = textOf(bundle.render('main:archive-manager')).join(' | ')
  assert.match(text, /暂无已归档的会话/)
  assert.match(text, /在会话行的菜单里执行「归档」后，会话会出现在这里。/)
})

test('the injected face never projects the raw hooks object', async () => {
  stubHost([ROW_COLD])
  const bundle = await loadBundle()
  await settle()
  const options = bundle.registrations.get('main:archive-manager').options
  const face = options.inject()
  assert.ok(face.hooks !== undefined, 'the face declares hook sources')
  const props = flattenFace(face, bundle.t)
  assert.equal(props.hooks, undefined, 'the renderer drops the hooks key')
  assert.equal(typeof props.useArchives, 'function')
  assert.equal(typeof props.useArchiveWorkspaces, 'function')
  assert.equal(typeof props.useArchiveSessions, 'function')
  assert.equal(props.useArchives((value) => value).items.length, 1)
})

test('the confirmation dialog lists the targets and gates the confirm button', async () => {
  stubHost([ROW_COLD])
  const bundle = await loadBundle()
  await settle()
  bundle.render('main:archive-manager').props // render once so the model is loaded
  const panel = bundle.registrations.get('main:archive-manager').options.inject()
  panel.requestDelete(['session-a'])
  const tree = bundle.render('shell.overlay:archive-manager-confirm')
  const text = textOf(tree).join(' | ')
  assert.match(text, /永久删除已归档会话/)
  assert.match(text, /以下 1 个会话将被从磁盘删除/)
  assert.match(text, /Alpha chat|session-a/)
  assert.match(text, /C:\\logs\\session-a/)
  const confirmButton = collect(tree).find((node) => node.type?.name === 'Button' && textOf(node.children).join('') === '永久删除')
  assert.equal(confirmButton.props.disabled, true, 'the confirm button starts disabled behind the acknowledgement')
})

test('the toast renders the outcome of a confirmed deletion', async () => {
  const calls = stubHost([ROW_COLD])
  const bundle = await loadBundle()
  await settle()
  const confirm = bundle.registrations.get('shell.overlay:archive-manager-confirm').options.inject()
  const panel = bundle.registrations.get('main:archive-manager').options.inject()
  assert.equal(bundle.render('shell.overlay:archive-manager-toast'), null, 'nothing to show before a deletion')

  panel.requestDelete(['session-a'])
  await confirm.onConfirm()
  await settle()
  assert.ok(calls.some((body) => body.op === 'deleteMany'), 'the confirmation posts the ids')
  const tree = bundle.render('shell.overlay:archive-manager-toast')
  assert.equal(tree.props.tone, 'success')
  assert.equal(tree.props.text, '已删除 1 个会话')
})

test('the row action appears only for archived sessions and dismisses the menu', async () => {
  const bundle = await loadBundle()
  const Row = bundle.registrations.get('sidebar.workspaces.session.menu.item:archive-manager.delete').component
  const calls = []
  const props = {
    t: bundle.t,
    sessionId: 'session-a',
    useMenuOpenState: () => [true, (open) => calls.push(['menu', open])],
    useWorkspaces: (selector) => selector({ archivedSessionIds: ['session-a'] }),
    requestDelete: (ids) => calls.push(ids),
  }
  const tree = Row(props)
  assert.equal(tree.type.name, 'MenuItemButton')
  assert.deepEqual(textOf(tree.children), ['永久删除'])
  tree.props.onSelect()
  assert.deepEqual(calls, [['menu', false], ['session-a']])

  assert.equal(Row({ ...props, sessionId: 'session-z' }), null, 'an unarchived row renders nothing')
  assert.deepEqual(textOf(Row({ ...props, t: bundle.tEn }).children), ['Delete permanently'])
})

test('the English dictionary covers every key the components use', async () => {
  const { tEn } = await loadBundle()
  for (const key of [
    'panel', 'title', 'subtitle', 'refresh', 'search', 'empty', 'emptyHint', 'selectAll', 'selected',
    'restore', 'restoreSelected', 'delete', 'deleteSelected', 'summary', 'unknownTitle', 'ungrouped',
    'subagent', 'time', 'sizeLabel', 'missing', 'confirmTitle', 'confirmIntro', 'confirmAck', 'cancel',
    'confirmDelete', 'deleteDone', 'deleteLive', 'deletePartial', 'deleteFailed', 'restoreDone', 'busy',
    'hostError', 'menuDelete', 'pendingRestart', 'close',
  ]) {
    assert.notEqual(tEn(key), key, `the English dictionary is missing "${key}"`)
  }
})
