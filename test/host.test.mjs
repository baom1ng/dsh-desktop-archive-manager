/**
 * Host-half integration tests: apply() wiring, request guards, the
 * destructive delete path, and the live-session policy — all driven through a
 * fake Cordis context.
 *
 * Run with:  node --test test/host.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../lib/host.js'

const SESSION = 'session-victim'
const LIVE = 'session-live'
const ACTIVE = 'session-active'
const KNOWN = 'session-keep'
const GHOST = 'session-ghost'

const exists = async (path) => {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

/**
 * Real directory layout plus a fake Cordis context.
 * @param options.archived - ids in the archive set.
 * @param options.live - ids this process still holds in memory.
 * @param options.stored - ids persistence reports (defaults to archived + KNOWN).
 */
async function harness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'archive-host-'))
  const project = join(root, '--C-projects-alpha--')
  const archived = new Set(options.archived ?? [SESSION])
  const live = new Set(options.live ?? [])
  const stored = new Set(options.stored ?? [...archived, KNOWN])
  const victimDir = join(project, SESSION)
  const keptDir = join(project, KNOWN)
  await mkdir(project, { recursive: true })
  if (stored.has(SESSION)) {
    await mkdir(victimDir, { recursive: true })
    await writeFile(join(victimDir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 5))
  }
  if (stored.has(KNOWN)) {
    await mkdir(keptDir, { recursive: true })
    await writeFile(join(keptDir, 'session.v4.jsonl.zstd'), Buffer.alloc(16, 5))
  }
  if ((options.directories ?? []).includes(GHOST)) await mkdir(join(project, GHOST), { recursive: true })

  const purged = []
  const unarchived = []
  const logs = []
  const routes = []

  const registry = {
    get archivedSessionIds() {
      return [...archived]
    },
    list: () => [{
      id: 'workspace-1',
      title: 'alpha',
      path: 'C:\\projects\\alpha',
      sessionIds: [...archived],
    }],
    unarchiveSession: async (id) => {
      unarchived.push(id)
      archived.delete(id)
    },
  }

  const persistence = {
    root,
    list: async () => [...stored].map((id) => ({
      header: { version: 4, id, createdAt: 1_700_000_000_000, cwd: 'C:\\projects\\alpha', isSeeded: false },
      sizeBytes: 2048,
    })),
    locate: (meta) => ({ kind: 'jsonl', path: join(root, '--C-projects-alpha--', meta.id, 'session.v4.jsonl.zstd') }),
  }

  const ctx = {
    logger: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]) },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    get: (service) => {
      if (service === 'storageDomain') {
        return { get: () => ({ table: () => ({ delete: async (key) => { purged.push(key); return true } }) }) }
      }
      if (service === 'agents') {
        return { get: (id) => (id === ACTIVE ? { status: 'running' } : live.has(id) ? { status: 'inactive' } : undefined) }
      }
      if (service === 'sessions') return { get: (id) => (live.has(id) ? {} : undefined) }
      return undefined
    },
    waterfall: async () => [],
    effect: (callback) => {
      callback()
      return () => {}
    },
  }

  // Cordis resolves the web surface through an optional injection; the fake
  // answers it immediately unless a test withholds the services.
  ctx.inject = (_services, callback) => {
    if (options.withholdInjection === true) return
    callback(ctx)
  }

  apply(ctx)
  const route = routes[0]

  /** Drive one request through the registered handler. */
  const call = async (payload, init = {}) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const request = {
      method: init.method ?? 'POST',
      headers: { host: '127.0.0.1:19387', ...(init.headers ?? {}) },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      },
    }
    const response = {
      writableEnded: false,
      status: undefined,
      body: undefined,
      writeHead(status) {
        this.status = status
      },
      end(chunk) {
        this.writableEnded = true
        this.body = chunk
      },
    }
    await route.handler(request, response)
    return { status: response.status, envelope: response.body === undefined ? undefined : JSON.parse(response.body) }
  }

  // `apply` prunes in the background; wait until the archive set settles so
  // assertions never race that sweep.
  let previous = JSON.stringify([...archived])
  for (let round = 0; round < 50; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    const next = JSON.stringify([...archived])
    if (next === previous && round >= 2) break
    previous = next
  }

  return {
    root, project, victimDir, keptDir, call, archived, live, purged, unarchived, logs, route,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('the row declares its service dependencies and registers one exact route', async () => {
  assert.equal(name, 'session-archive-manager')
  assert.deepEqual(inject, [], 'the web surface is optional so the row activates anywhere')
  const h = await harness()
  try {
    assert.equal(h.route.kind, 'exact')
    assert.equal(h.route.path, '/archive-manager/api')
    assert.equal(typeof h.route.handler, 'function')
  }
  finally {
    await h.cleanup()
  }
})

test('without a webserver the row activates and registers nothing', async () => {
  const h = await harness({ withholdInjection: true })
  try {
    assert.equal(h.route, undefined, 'no route without a webserver')
    assert.equal(h.logs.length, 0, 'no startup log for a surface that never resolved')
  }
  finally {
    await h.cleanup()
  }
})

test('list reports every archived session with its storage footprint', async () => {
  const h = await harness()
  try {
    const { status, envelope } = await h.call({ op: 'list' })
    assert.equal(status, 200)
    assert.equal(envelope.ok, true)
    assert.equal(envelope.value.storageRoot, h.root)
    assert.equal(envelope.value.items.length, 1)
    const item = envelope.value.items[0]
    assert.equal(item.sessionId, SESSION)
    assert.equal(item.present, true)
    assert.equal(item.bytes, 2048)
    assert.equal(item.files, 1)
    assert.equal(item.workspaceTitle, 'alpha')
    assert.equal(item.directory, h.victimDir)
    assert.equal(item.origin, 'session')
    assert.equal(item.live, false)
    assert.equal(item.pendingRestart, false)
  }
  finally {
    await h.cleanup()
  }
})

test('plan describes a deletion without performing it', async () => {
  const h = await harness()
  try {
    const { envelope } = await h.call({ op: 'plan', sessionId: SESSION })
    assert.equal(envelope.value.archived, true)
    assert.equal(envelope.value.present, true)
    assert.equal(envelope.value.bytes, 2048)
    assert.equal(envelope.value.live, false)
    assert.equal(await exists(h.victimDir), true)
    assert.deepEqual(h.purged, [])
    assert.deepEqual(h.unarchived, [])
  }
  finally {
    await h.cleanup()
  }
})

test('a cold delete removes the artifacts, the cache record, and the archive mark', async () => {
  const h = await harness()
  try {
    const { status, envelope } = await h.call({ op: 'delete', sessionId: SESSION })
    assert.equal(status, 200)
    assert.equal(envelope.ok, true)
    assert.equal(envelope.value.removed, true)
    assert.equal(envelope.value.bytes, 2048)
    assert.equal(envelope.value.projectionCache, true)
    assert.equal(envelope.value.live, false)
    assert.equal(envelope.value.pendingRestart, false)
    assert.deepEqual(envelope.value.remaining, [])

    assert.equal(await exists(h.victimDir), false, 'the archived session directory is gone')
    assert.equal(await exists(h.keptDir), true, 'an unarchived sibling survives')
    assert.deepEqual(h.purged, [SESSION])
    assert.deepEqual(h.unarchived, [SESSION])
    assert.equal(h.archived.has(SESSION), false)
  }
  finally {
    await h.cleanup()
  }
})

test('a live session loses its data but keeps its archive mark', async () => {
  const h = await harness({ archived: [LIVE], live: [LIVE], stored: [LIVE, KNOWN], directories: [] })
  try {
    await mkdir(join(h.project, LIVE), { recursive: true })
    await writeFile(join(h.project, LIVE, 'session.v4.jsonl.zstd'), Buffer.alloc(512, 9))

    const { envelope } = await h.call({ op: 'delete', sessionId: LIVE })
    assert.equal(envelope.ok, true)
    assert.equal(envelope.value.removed, true)
    assert.equal(envelope.value.live, true)
    assert.equal(envelope.value.pendingRestart, true)
    assert.deepEqual(envelope.value.remaining, [LIVE], 'the archive mark is retained')
    assert.equal(await exists(join(h.project, LIVE)), false)
    assert.deepEqual(h.unarchived, [])

    const listed = await h.call({ op: 'list' })
    const row = listed.envelope.value.items[0]
    assert.equal(row.present, false)
    assert.equal(row.live, true)
    assert.equal(row.pendingRestart, true)
  }
  finally {
    await h.cleanup()
  }
})

test('prune sweeps marks whose session is gone, keeping stored and live ones', async () => {
  const h = await harness({
    archived: [GHOST, KNOWN, LIVE],
    live: [LIVE],
    stored: [KNOWN, LIVE],
    directories: [],
  })
  try {
    // `apply()` already pruned once at startup; the explicit operation reports
    // the settled archive set and is idempotent.
    assert.equal(h.archived.has(GHOST), false, 'the startup prune dropped the ghost mark')
    const { envelope } = await h.call({ op: 'prune' })
    assert.deepEqual(envelope.value.pruned, [])
    assert.deepEqual(envelope.value.archived, [KNOWN, LIVE])
    assert.equal(h.archived.has(KNOWN), true, 'a stored session keeps its mark')
    assert.equal(h.archived.has(LIVE), true, 'a live session keeps its mark')
  }
  finally {
    await h.cleanup()
  }
})

test('prune keeps a mark whose log is unreadable but still on disk', async () => {
  const h = await harness({
    archived: [GHOST],
    stored: [KNOWN],
    directories: [GHOST],
  })
  try {
    const { envelope } = await h.call({ op: 'prune' })
    assert.deepEqual(envelope.value.pruned, [])
    assert.deepEqual(envelope.value.archived, [GHOST])
  }
  finally {
    await h.cleanup()
  }
})

test('a session that is not archived is refused before any IO', async () => {
  const h = await harness({ archived: [], stored: [SESSION, KNOWN] })
  try {
    const { envelope } = await h.call({ op: 'delete', sessionId: SESSION })
    assert.equal(envelope.ok, false)
    assert.equal(envelope.error.code, 'archive-manager/not-archived')
    assert.equal(await exists(h.victimDir), true)
    assert.deepEqual(h.purged, [])
  }
  finally {
    await h.cleanup()
  }
})

test('a session with running work is refused', async () => {
  const h = await harness({ archived: [ACTIVE], live: [ACTIVE] })
  try {
    const { envelope } = await h.call({ op: 'delete', sessionId: ACTIVE })
    assert.equal(envelope.ok, false)
    assert.equal(envelope.error.code, 'archive-manager/session-active')
    assert.equal(h.archived.has(ACTIVE), true)
  }
  finally {
    await h.cleanup()
  }
})

test('path-like ids never reach the filesystem', async () => {
  const h = await harness()
  try {
    for (const bad of ['../escape', 'a/b', '..', 'C:\\Windows']) {
      const { envelope } = await h.call({ op: 'delete', sessionId: bad })
      assert.equal(envelope.ok, false)
      assert.equal(envelope.error.code, 'archive-manager/invalid-session-id')
    }
    assert.equal(await exists(h.victimDir), true)
  }
  finally {
    await h.cleanup()
  }
})

test('request guards reject other methods, cross-origin callers, and bad bodies', async () => {
  const h = await harness()
  try {
    const wrongMethod = await h.call('', { method: 'GET' })
    assert.equal(wrongMethod.status, 400)
    assert.equal(wrongMethod.envelope.error.code, 'archive-manager/bad-request')

    const crossOrigin = await h.call({ op: 'list' }, { headers: { origin: 'https://evil.example' } })
    assert.equal(crossOrigin.status, 400)
    assert.equal(crossOrigin.envelope.error.code, 'archive-manager/bad-request')

    const sameOrigin = await h.call({ op: 'list' }, { headers: { origin: 'http://127.0.0.1:19387' } })
    assert.equal(sameOrigin.envelope.ok, true)

    const broken = await h.call('{not json')
    assert.equal(broken.envelope.error.code, 'archive-manager/bad-request')

    const unknown = await h.call({ op: 'nope' })
    assert.equal(unknown.envelope.error.code, 'archive-manager/unknown-op')
  }
  finally {
    await h.cleanup()
  }
})

test('deleteMany reports per-session outcomes and keeps going', async () => {
  const h = await harness({ archived: [SESSION, 'session-missing'] })
  try {
    const { envelope } = await h.call({ op: 'deleteMany', sessionIds: [SESSION, 'session-missing', 'bad/id'] })
    assert.equal(envelope.ok, true)
    const [removed, absent, invalid] = envelope.value.results
    assert.equal(removed.sessionId, SESSION)
    assert.equal(removed.removed, true)
    // A session with no stored log still leaves the archive set.
    assert.equal(absent.sessionId, 'session-missing')
    assert.equal(absent.removed, false)
    assert.equal(absent.error, undefined)
    assert.equal(invalid.error.code, 'archive-manager/invalid-session-id')
    assert.deepEqual(envelope.value.remaining, [])
    assert.equal(await exists(h.victimDir), false)
  }
  finally {
    await h.cleanup()
  }
})

test('status exposes the endpoint and the current archive set', async () => {
  const h = await harness()
  try {
    const { envelope } = await h.call({ op: 'status' })
    assert.equal(envelope.value.route, '/archive-manager/api')
    assert.equal(envelope.value.storageRoot, h.root)
    assert.deepEqual(envelope.value.archived, [SESSION])
  }
  finally {
    await h.cleanup()
  }
})
