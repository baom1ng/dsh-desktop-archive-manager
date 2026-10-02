/**
 * Session archive manager — host half.
 *
 * Adds one same-origin HTTP endpoint that the browser half calls:
 *
 *   POST /archive-manager/api
 *   { op: 'list' | 'plan' | 'delete' | 'deleteMany' | 'status', ... }
 *
 * Deletion policy, in order:
 *   1. only a session currently in the Workspace registry's archive set;
 *   2. never a session with running work;
 *   3. a session that is **cold** (no live Agent/Session in this process)
 *      loses its artifact directory, its projection-cache record, and its
 *      archive mark, so its row leaves the sidebar immediately;
 *   4. a session that is still **live** in this process keeps its archive
 *      mark — the archived gate already blocks new turns, so the mark is what
 *      keeps a logless in-memory session from being prompted again. The row
 *      stays hidden with the other archived rows and `prune()` removes the
 *      stale mark on the next start, once the process no longer holds it.
 *
 * `apply()` also runs that prune once at startup, so this package heals any
 * archive entry left behind by an earlier run.
 *
 * @module dsh-desktop-archive-manager
 */

import {
  ArchiveManagerError, FAILURE, assertSessionId, findSessionDirectory,
  locateSessionLog, planDirectoryRemoval, planSessionRemoval, removeSessionDirectory,
} from './core.js'

/** Cordis plugin name. */
export const name = 'session-archive-manager'

/**
 * The web surface this row extends. Declared as an optional injection rather
 * than a hard `inject` list so the row still *activates* on a profile without a
 * webserver (headless/CLI): there it simply registers nothing instead of
 * sitting pending forever, which is what an ecosystem install check probes.
 */
const WEB_SERVICES = ['webServer', 'workspaceRegistry', 'sessionPersistence']

/** No hard service dependency: the web surface is awaited inside `apply`. */
export const inject = []

/** Exact route the browser half calls. */
const ROUTE_PATH = '/archive-manager/api'

/** Request-body cap; these payloads carry ids only. */
const MAX_BODY_BYTES = 128 * 1024

/** Register the endpoint for the lifetime of this row. */
export function apply(ctx) {
  ctx.inject(WEB_SERVICES, (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (request, response) => handle(webCtx, request, response),
      }),
      'session-archive-manager: http endpoint',
    )
    logOf(webCtx).info('archive manager endpoint ready at %s', ROUTE_PATH)
    void pruneArchiveSet(webCtx)
  })
}

function logOf(ctx) {
  const logger = ctx.logger
  if (logger !== undefined && logger !== null) return logger
  return console
}

/** Route every accepted request to one operation. */
async function handle(ctx, request, response) {
  try {
    if (request.method === 'OPTIONS') {
      // No CORS headers are sent, so a cross-origin preflight fails here.
      writeJson(response, 204, undefined)
      return
    }
    if (request.method !== 'POST') {
      throw new ArchiveManagerError(FAILURE.badRequest, `expected POST, received ${String(request.method)}`)
    }
    assertSameOrigin(request)
    const body = await readJsonBody(request)
    const value = await dispatch(ctx, body)
    writeJson(response, 200, { ok: true, value })
  }
  catch (error) {
    const failure = error instanceof ArchiveManagerError
      ? error
      : new ArchiveManagerError('archive-manager/internal', error instanceof Error ? error.message : String(error))
    if (!(error instanceof ArchiveManagerError)) logOf(ctx).warn(error)
    writeJson(response, failure.code === FAILURE.badRequest ? 400 : 200, {
      ok: false,
      error: { code: failure.code, message: failure.message, details: failure.details },
    })
  }
}

/** Reject a request whose browser Origin is not this very server. */
function assertSameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return
  let host
  try {
    host = new URL(origin).host
  }
  catch {
    throw new ArchiveManagerError(FAILURE.badRequest, `invalid Origin header: ${origin}`)
  }
  if (host !== request.headers.host) {
    throw new ArchiveManagerError(FAILURE.badRequest, `cross-origin request refused: ${origin}`)
  }
}

/** Read and parse a bounded JSON body. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ArchiveManagerError(FAILURE.bodyTooLarge, 'request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  }
  catch {
    throw new ArchiveManagerError(FAILURE.badRequest, 'request body is not valid JSON')
  }
}

function writeJson(response, status, payload) {
  if (response.writableEnded === true) return
  if (payload === undefined) {
    response.writeHead(status, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** One operation per request. */
async function dispatch(ctx, body) {
  const op = body !== null && typeof body === 'object' ? body.op : undefined
  switch (op) {
    case 'list':
      return await listArchived(ctx)
    case 'plan':
      return await planOne(ctx, body.sessionId)
    case 'delete':
      return await deleteOne(ctx, body.sessionId)
    case 'deleteMany': {
      const ids = Array.isArray(body.sessionIds) ? body.sessionIds : []
      const results = []
      for (const id of ids) {
        try {
          results.push(await deleteOne(ctx, id))
        }
        catch (error) {
          results.push({
            sessionId: typeof id === 'string' ? id : String(id),
            removed: false,
            error: error instanceof ArchiveManagerError
              ? { code: error.code, message: error.message }
              : { code: 'archive-manager/internal', message: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      return { results, remaining: await archivedIds(ctx) }
    }
    case 'prune':
      return { pruned: await pruneArchiveSet(ctx), archived: await archivedIds(ctx) }
    case 'status':
      return { route: ROUTE_PATH, storageRoot: storageRootOf(ctx), archived: await archivedIds(ctx) }
    default:
      throw new ArchiveManagerError(FAILURE.unknownOp, `unknown operation: ${JSON.stringify(op)}`)
  }
}

async function archivedIds(ctx) {
  const registry = ctx.workspaceRegistry
  const ids = registry !== undefined && registry !== null ? registry.archivedSessionIds : undefined
  return Array.isArray(ids) ? [...ids] : []
}

/** The configured persistence root, when the backend exposes it. */
function storageRootOf(ctx) {
  const persistence = ctx.sessionPersistence
  if (persistence !== undefined && persistence !== null && typeof persistence.root === 'string') return persistence.root
  return undefined
}

/** Whether this process still holds a live Agent or Session for the id. */
function isLive(ctx, sessionId) {
  try {
    const agents = ctx.get('agents')
    if (agents !== undefined && agents !== null && agents.get(sessionId) !== undefined) return true
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && sessions !== null && sessions.get(sessionId) !== undefined) return true
  }
  catch {
    // An unavailable registry is treated as "not live"; the archive mark stays.
  }
  return false
}

/** Stored headers by session id, or an empty map when persistence cannot read. */
async function storedHeaders(ctx) {
  const persistence = ctx.sessionPersistence
  const headers = new Map()
  let snapshots = []
  try {
    snapshots = await persistence.list()
  }
  catch (error) {
    logOf(ctx).warn(error)
  }
  for (const snapshot of snapshots) {
    const header = snapshot === null || typeof snapshot !== 'object' ? undefined : snapshot.header
    if (header !== undefined && header !== null && typeof header.id === 'string') headers.set(header.id, header)
  }
  return headers
}

/** Read every archived session with the facts the browser needs to list it. */
async function listArchived(ctx) {
  const registry = ctx.workspaceRegistry
  const ids = await archivedIds(ctx)
  const headers = await storedHeaders(ctx)

  const workspaces = []
  try {
    for (const workspace of registry.list()) {
      workspaces.push({ id: workspace.id, title: workspace.title, path: workspace.path, sessionIds: [...workspace.sessionIds] })
    }
  }
  catch (error) {
    logOf(ctx).warn(error)
  }

  const root = storageRootOf(ctx)
  const items = []
  for (const sessionId of ids) {
    const header = headers.get(sessionId)
    const plan = await planFor(ctx, sessionId, header)
    const owner = workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
    const live = isLive(ctx, sessionId)
    items.push({
      sessionId,
      createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
      cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
      origin: typeof header?.origin === 'string' ? header.origin : 'session',
      present: plan.present,
      bytes: plan.bytes,
      files: plan.files,
      directory: plan.directory,
      live,
      // A logless session this process still holds: its data is already gone,
      // and the next start sweeps the leftover archive mark.
      pendingRestart: plan.present === false && live,
      workspaceId: owner?.id,
      workspaceTitle: owner?.title,
      workspacePath: owner?.path,
    })
  }
  return { items, storageRoot: root, generatedAt: Date.now() }
}

/** Describe one deletion without performing it. */
async function planOne(ctx, sessionId) {
  const id = assertSessionId(sessionId)
  const archived = await archivedIds(ctx)
  const headers = await storedHeaders(ctx)
  const plan = await planFor(ctx, id, headers.get(id))
  return { ...plan, archived: archived.includes(id), live: isLive(ctx, id) }
}

/**
 * Resolve one session's artifacts.
 * @returns `{ sessionId, present, directory, bytes, files }`.
 */
async function planFor(ctx, sessionId, header) {
  const persistence = ctx.sessionPersistence
  const logPath = header !== undefined ? locateSessionLog(persistence, header) : undefined
  if (logPath !== undefined) return await planSessionRemoval({ sessionId, logPath })
  const directory = await findSessionDirectory(storageRootOf(ctx), sessionId)
  if (directory === undefined) return { sessionId, present: false, directory: undefined, bytes: 0, files: 0 }
  return await planDirectoryRemoval(sessionId, directory)
}

/** Refuse to remove a session that still has work running. */
async function assertQuiet(ctx, sessionId) {
  const activity = []
  try {
    const reported = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    if (Array.isArray(reported)) activity.push(...reported)
  }
  catch (error) {
    logOf(ctx).warn(error)
  }
  const agents = ctx.get('agents')
  const agent = agents !== undefined && agents !== null ? agents.get(sessionId) : undefined
  if (agent !== undefined && agent.status === 'running') {
    activity.push({ kind: 'agent', items: [{ label: 'running turn' }] })
  }
  if (activity.length > 0) {
    throw new ArchiveManagerError(
      FAILURE.sessionActive,
      `session ${sessionId} still has running work; stop it first`,
      { activity },
    )
  }
}

/** Permanently remove one archived session's stored artifacts. */
async function deleteOne(ctx, sessionId) {
  const id = assertSessionId(sessionId)
  const registry = ctx.workspaceRegistry
  if (!(await archivedIds(ctx)).includes(id)) {
    throw new ArchiveManagerError(FAILURE.notArchived, `session ${id} is not archived`, { sessionId: id })
  }
  await assertQuiet(ctx, id)
  const headers = await storedHeaders(ctx)
  const plan = await planFor(ctx, id, headers.get(id))
  if (plan.present && typeof plan.directory === 'string') await removeSessionDirectory(plan.directory)
  const projectionCache = await purgeProjectionCache(ctx, id)
  const live = isLive(ctx, id)
  if (!live) {
    // Cold: the row can leave every surface right away.
    await registry.unarchiveSession(id)
  }
  logOf(ctx).info(
    'deleted archived session %s (%d files, %d bytes, live=%s)',
    id, plan.files, plan.bytes, String(live),
  )
  return {
    sessionId: id,
    removed: plan.present,
    directory: plan.directory,
    bytes: plan.bytes,
    files: plan.files,
    projectionCache,
    live,
    pendingRestart: live,
    remaining: await archivedIds(ctx),
  }
}

/**
 * Drop archive marks whose session is neither stored nor live — leftovers of a
 * deletion performed while the session was still in memory, or of sessions
 * removed outside the app.
 * @returns the session ids whose mark was dropped.
 */
async function pruneArchiveSet(ctx) {
  const pruned = []
  let ids
  try {
    ids = await archivedIds(ctx)
  }
  catch (error) {
    logOf(ctx).warn(error)
    return pruned
  }
  if (ids.length === 0) return pruned
  const headers = await storedHeaders(ctx)
  const root = storageRootOf(ctx)
  for (const sessionId of ids) {
    if (headers.has(sessionId) || isLive(ctx, sessionId)) continue
    // A stored-but-unreadable log is kept: `list()` omits unreadable headers
    // and its directory is the evidence that something is still there.
    if (await findSessionDirectory(root, sessionId) !== undefined) continue
    try {
      await ctx.workspaceRegistry.unarchiveSession(sessionId)
      pruned.push(sessionId)
    }
    catch (error) {
      logOf(ctx).warn(error)
    }
  }
  if (pruned.length > 0) logOf(ctx).info('pruned %d archived session mark(s) with no stored log', pruned.length)
  return pruned
}

/** Drop the session's durable projection checkpoint, when that store is mounted. */
async function purgeProjectionCache(ctx, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain === undefined || storageDomain === null || typeof storageDomain.get !== 'function') return false
  const domain = storageDomain.get('session_projcache')
  if (domain === undefined || domain === null || typeof domain.table !== 'function') return false
  const table = domain.table('sessions')
  if (table === undefined || table === null || typeof table.delete !== 'function') return false
  try {
    return (await table.delete(sessionId)) === true
  }
  catch (error) {
    logOf(ctx).warn(error)
    return false
  }
}
