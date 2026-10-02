/**
 * Dependency-free core of the session archive manager host half.
 *
 * Everything destructive lives here, so it can be unit-tested without a
 * running Harness: path resolution, planning, and the actual directory
 * removal. The Cordis wiring lives in `host.js`.
 *
 * @module dsh-desktop-archive-manager/core
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Stable failure codes returned to the browser half. */
export const FAILURE = {
  badRequest: 'archive-manager/bad-request',
  invalidSessionId: 'archive-manager/invalid-session-id',
  notArchived: 'archive-manager/not-archived',
  sessionActive: 'archive-manager/session-active',
  bodyTooLarge: 'archive-manager/body-too-large',
  unknownOp: 'archive-manager/unknown-op',
}

/** Structured failure carrying a browser-facing code. */
export class ArchiveManagerError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - human-readable detail.
   * @param details - extra JSON detail for the caller.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ArchiveManagerError'
    this.code = code
    this.details = details
  }
}

/** Session ids are used as one path segment, so the shape is deliberately strict. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/**
 * Reject anything that could escape its session directory.
 * @param value - candidate session id.
 * @returns the same id when it is safe.
 */
export function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value) || value.includes('..')) {
    throw new ArchiveManagerError(FAILURE.invalidSessionId, `invalid session id: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Sum the bytes and file count below one directory.
 * @param directory - absolute directory path.
 * @returns `{ bytes, files }`; unreadable entries are skipped.
 */
export async function directoryStats(directory) {
  let bytes = 0
  let files = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      try {
        const info = await stat(child)
        bytes += info.size
        files += 1
      }
      catch {
        // A file that vanished between readdir and stat contributes nothing.
      }
    }
  }
  await walk(directory)
  return { bytes, files }
}

/**
 * Describe what deleting one session directory would remove, without removing it.
 * @param sessionId - the session the directory belongs to.
 * @param directory - the session-owned directory.
 * @returns a detached plan record.
 */
export async function planDirectoryRemoval(sessionId, directory) {
  let info
  try {
    info = await stat(directory)
  }
  catch {
    info = undefined
  }
  if (info === undefined || !info.isDirectory()) {
    return { sessionId, directory, present: false, bytes: 0, files: 0 }
  }
  const { bytes, files } = await directoryStats(directory)
  return { sessionId, directory, present: true, bytes, files }
}

/**
 * Describe what deleting one session would remove, without removing it.
 * The artifact directory owns every stored format generation.
 * @param options - session id plus the session's log file path.
 * @returns a detached plan record.
 */
export async function planSessionRemoval({ sessionId, logPath }) {
  const plan = await planDirectoryRemoval(sessionId, dirname(logPath))
  return { ...plan, logPath }
}

/**
 * Remove one session's artifact directory (every stored format generation).
 * @param directory - the session-owned directory to remove.
 */
export async function removeSessionDirectory(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Ask the mounted persistence backend where a session's log lives.
 * @param persistence - the `sessionPersistence` service.
 * @param header - that session's stored header.
 * @returns the absolute log file path, or undefined when the backend cannot say.
 */
export function locateSessionLog(persistence, header) {
  if (persistence === undefined || persistence === null) return undefined
  if (typeof persistence.locate !== 'function') return undefined
  try {
    const located = persistence.locate({ id: header.id, cwd: header.cwd })
    if (located !== null && typeof located === 'object' && typeof located.path === 'string') return located.path
  }
  catch {
    return undefined
  }
  return undefined
}

/**
 * Fallback discovery for backends without `locate`: find `<root>/<project>/<id>`.
 * @param root - the persistence root directory.
 * @param sessionId - the session directory name (session ids are safe segments).
 * @returns the absolute session directory, or undefined.
 */
export async function findSessionDirectory(root, sessionId) {
  if (typeof root !== 'string' || root === '') return undefined
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  }
  catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    }
    catch {
      // Not this project directory.
    }
  }
  return undefined
}
