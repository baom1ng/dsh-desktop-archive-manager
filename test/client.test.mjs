/**
 * Browser-half tests: bundle shape, slot registrations, and the model's
 * host calls driven through a fake `fetch`.
 *
 * Run with:  node --test test/client.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** Minimal snapshot store with the same observable surface as the real one. */
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

function fakeCtx() {
  const registrations = []
  const effects = []
  let archiveIds = ['session-archived']
  const workspaces = {
    list: {
      getSnapshot: () => ({ items: [], archivedSessionIds: archiveIds, pinnedSessionIds: [], state: 'ready', phase: 'ready', error: null }),
      subscribe: () => () => {},
    },
  }
  const sessions = {
    list: fakeStore({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    refresh: async () => { refreshCalls += 1 },
  }
  let refreshCalls = 0
  const ctx = {
    locale: {
      register: (ns, dicts) => {
        registrations.push({ kind: 'locale', ns, dicts })
      },
      bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    },
    slots: {
      inject: (slot, callback) => {
        registrations.push({ kind: 'inject', slot })
        callback()
      },
      register: (options, component) => {
        registrations.push({ kind: 'slot', options, component })
        return () => {}
      },
    },
    workspaces,
    sessions,
    uiWorkspace: {
      unarchiveSession: async (id) => { unarchived.push(id) },
    },
    effect: (callback) => {
      effects.push(callback())
      return () => {}
    },
  }
  const unarchived = []
  return {
    ctx,
    registrations,
    effects,
    unarchived,
    get refreshCalls() { return refreshCalls },
    setArchiveIds: (ids) => { archiveIds = ids },
  }
}

/** Load the prebuilt bundle once and hand back its registered factory. */
let bundleGeneration = 0
async function loadBundle() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load: (spec) => {
        captured = spec
      },
    },
  }
  const styles = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(value) { this._text = value }, get textContent() { return this._text } }),
    head: { appendChild: (node) => styles.push(node) },
  }
  // A fresh specifier per call: the browser loads this bundle once, but each
  // test needs the module body to run again.
  bundleGeneration += 1
  await import(`../lib/client.js?gen=${String(bundleGeneration)}`)
  assert.ok(captured !== undefined, 'the bundle registers itself with the module loader')
  assert.equal(captured.id, 'dsh-desktop-archive-manager')

  const primitives = new Proxy({}, {
    get: (target, key) => {
      if (key === 'fileSizeText') return (bytes) => `${bytes}B`
      return function Stub() { return null }
    },
  })
  const require = (specifier) => {
    switch (specifier) {
      case 'react':
        return { useState: (value) => [value, () => {}], useEffect: () => {}, useSyncExternalStore: () => undefined, createElement: () => null, Fragment: {} }
      case 'react/jsx-runtime':
        return { jsx: () => null, jsxs: () => null }
      case '@deepseek-ai/dsh-client-ui-primitives':
        return primitives
      case '@deepseek-ai/dsh-client-store':
        return { createSnapshotStore: fakeStore }
      default:
        throw new Error(`unexpected require: ${specifier}`)
    }
  }
  return { plugin: captured.factory(require), styles }
}

test('the bundle exposes a Cordis plugin with its service dependencies', async () => {
  const { plugin, styles } = await loadBundle()
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'sessions', 'slots', 'uiWorkspace', 'workspaces'])
  assert.equal(styles.length, 1, 'the bundle installs its stylesheet once')
  assert.equal(styles[0].dataset.plugin, 'dsh-desktop-archive-manager')
})

test('apply registers the panel, the row action, and both overlay entries', async () => {
  const { plugin } = await loadBundle()
  const h = fakeCtx()
  plugin.apply(h.ctx)

  const slots = h.registrations.filter((entry) => entry.kind === 'slot').map((entry) => entry.options)
  const byId = new Map(slots.map((options) => [`${options.name}:${options.id ?? options.key}`, options]))
  assert.deepEqual([...byId.keys()].sort(), [
    'main:archive-manager',
    'shell.overlay:archive-manager-confirm',
    'shell.overlay:archive-manager-toast',
    'sidebar.panellist:archive-manager',
    'sidebar.workspaces.session.menu.item:archive-manager.delete',
  ])
  assert.equal(byId.get('main:archive-manager').name, 'main')
  assert.equal(byId.get('main:archive-manager').key, 'archive-manager')
  assert.equal(typeof byId.get('main:archive-manager').inject, 'function')
  assert.equal(byId.get('sidebar.panellist:archive-manager').name, 'sidebar.panellist')
  assert.equal(byId.get('sidebar.panellist:archive-manager').order, 30)
  assert.equal(byId.get('sidebar.workspaces.session.menu.item:archive-manager.delete').order, 900)
  assert.equal(byId.get('shell.overlay:archive-manager-confirm').name, 'shell.overlay')
  assert.equal(byId.get('shell.overlay:archive-manager-toast').name, 'shell.overlay')

  const injected = h.registrations.filter((entry) => entry.kind === 'inject').map((entry) => entry.slot)
  assert.deepEqual([...injected].sort(), [
    'main', 'shell.overlay', 'shell.overlay', 'sidebar.panellist', 'sidebar.workspaces.session.menu.item',
  ])

  const locale = h.registrations.find((entry) => entry.kind === 'locale')
  assert.equal(locale.ns, 'archive-manager')
  assert.deepEqual(Object.keys(locale.dicts.en).sort(), Object.keys(locale.dicts.zh).sort())
})

test('the panel face loads the archive list from the host half', async () => {
  const { plugin } = await loadBundle()
  const h = fakeCtx()
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          items: [{ sessionId: 'session-archived', present: true, bytes: 2048, files: 1, directory: '/logs/session-archived', workspaceTitle: 'alpha' }],
          storageRoot: '/logs',
        },
      }),
    }
  }
  plugin.apply(h.ctx)
  const main = h.registrations.find((entry) => entry.kind === 'slot' && entry.options.key === 'archive-manager')
  const face = main.options.inject()

  await face.hooks.archives.load()
  assert.equal(calls.at(-1).url, '/archive-manager/api')
  assert.deepEqual(calls.at(-1).body, { op: 'list' })
  const state = face.hooks.archives.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.items.length, 1)
  assert.equal(state.storageRoot, '/logs')
})

test('confirming a deletion posts the ids, refreshes sessions, and reports the outcome', async () => {
  const { plugin } = await loadBundle()
  const h = fakeCtx()
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.op === 'list') {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { items: [], storageRoot: '/logs' } }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: { results: body.sessionIds.map((sessionId) => ({ sessionId, removed: true, bytes: 10, files: 1 })), remaining: [] },
      }),
    }
  }
  plugin.apply(h.ctx)
  const overlay = h.registrations.find((entry) => entry.kind === 'slot' && entry.options.id === 'archive-manager-confirm')
  const face = overlay.options.inject()

  face.hooks.archives.requestDelete(['session-archived'])
  assert.deepEqual(face.hooks.archives.getSnapshot().confirm.ids, ['session-archived'])

  await face.onConfirm()
  const deleteCall = calls.find((body) => body.op === 'deleteMany')
  assert.deepEqual(deleteCall, { op: 'deleteMany', sessionIds: ['session-archived'] })
  const state = face.hooks.archives.getSnapshot()
  assert.equal(state.confirm, null)
  assert.equal(state.busy, false)
  assert.equal(state.notice.text, 'deleteDone')
  assert.equal(state.notice.params.count, 1)
  assert.equal(state.notice.tone, 'success')
  assert.ok(h.refreshCalls >= 1, 'the session baseline is re-pulled so the deleted row leaves the sidebar')
})

test('a failed deletion surfaces the failure instead of a false success', async () => {
  const { plugin } = await loadBundle()
  const h = fakeCtx()
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.op === 'list') {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { items: [], storageRoot: '/logs' } }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: { code: 'archive-manager/not-archived', message: 'session x is not archived', details: {} } }),
    }
  }
  plugin.apply(h.ctx)
  const overlay = h.registrations.find((entry) => entry.kind === 'slot' && entry.options.id === 'archive-manager-confirm')
  const face = overlay.options.inject()
  face.hooks.archives.requestDelete(['session-x'])
  await face.onConfirm()
  const state = face.hooks.archives.getSnapshot()
  assert.equal(state.busy, false)
  assert.equal(state.confirm, null)
  assert.equal(state.notice.text, 'deleteFailed')
  assert.match(state.notice.params.detail, /not archived/)
})

test('a live session reports that its cleanup waits for a restart', async () => {
  const { plugin } = await loadBundle()
  const h = fakeCtx()
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.op === 'list') {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { items: [], storageRoot: '/logs' } }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          results: [{ sessionId: 'session-live', removed: true, live: true, pendingRestart: true, bytes: 512, files: 1 }],
          remaining: ['session-live'],
        },
      }),
    }
  }
  plugin.apply(h.ctx)
  const overlay = h.registrations.find((entry) => entry.kind === 'slot' && entry.options.id === 'archive-manager-confirm')
  const face = overlay.options.inject()
  face.hooks.archives.requestDelete(['session-live'])
  await face.onConfirm()
  const notice = face.hooks.archives.getSnapshot().notice
  assert.equal(notice.text, 'deleteLive')
  assert.equal(notice.tone, 'warn')
  assert.deepEqual(notice.params, { count: 1, live: 1 })
})

test('restore unarchives through the client workspace service', async () => {
  const { plugin } = await loadBundle()
  const h = fakeCtx()
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { items: [], storageRoot: '/logs' } }) })
  plugin.apply(h.ctx)
  const main = h.registrations.find((entry) => entry.kind === 'slot' && entry.options.key === 'archive-manager')
  const face = main.options.inject()
  await face.restore(['session-archived', 'session-two'])
  assert.deepEqual(h.unarchived, ['session-archived', 'session-two'])
  assert.equal(face.hooks.archives.getSnapshot().notice.text, 'restoreDone')
})

test('an unreachable host half is reported, not thrown', async () => {
  const { plugin } = await loadBundle()
  const h = fakeCtx()
  globalThis.fetch = async () => {
    throw new Error('socket closed')
  }
  plugin.apply(h.ctx)
  const main = h.registrations.find((entry) => entry.kind === 'slot' && entry.options.key === 'archive-manager')
  const face = main.options.inject()
  await face.hooks.archives.load()
  const state = face.hooks.archives.getSnapshot()
  assert.equal(state.status, 'error')
  assert.match(state.error, /socket closed/)
})

test('the archive set watcher reloads the list when the sidebar archives something', async () => {
  const { plugin } = await loadBundle()
  const h = fakeCtx()
  let reloads = 0
  const listeners = new Set()
  h.ctx.workspaces.list = {
    getSnapshot: () => ({ items: [], archivedSessionIds: h.ctx.workspaces.list.ids ?? [], pinnedSessionIds: [], state: 'ready', phase: 'ready', error: null }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.op === 'list') reloads += 1
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { items: [], storageRoot: undefined } }) }
  }
  plugin.apply(h.ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const before = reloads
  listeners.forEach((listener) => listener())
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(reloads, before, 'an unchanged archive set does not reload')
})
