/**
 * Unit tests for the archive manager's destructive core.
 *
 * Run with:  node --test test/core.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  ArchiveManagerError, assertSessionId, directoryStats, findSessionDirectory,
  locateSessionLog, planDirectoryRemoval, planSessionRemoval, removeSessionDirectory,
} from '../lib/core.js'

/** Build a throwaway persistence root with two projects and three sessions. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'archive-manager-'))
  const projectA = join(root, '--C-projects-alpha--')
  const projectB = join(root, '--C-projects-beta--')
  const victim = join(projectA, 'session-victim')
  const keep = join(projectA, 'session-keep')
  const other = join(projectB, 'session-other')
  for (const directory of [victim, keep, other]) await mkdir(directory, { recursive: true })
  await writeFile(join(victim, 'session.v4.jsonl.zstd'), Buffer.alloc(1500, 7))
  await writeFile(join(victim, 'session.v3.jsonl.zstd'), Buffer.alloc(500, 7))
  await writeFile(join(keep, 'session.v4.jsonl.zstd'), Buffer.alloc(64, 1))
  await writeFile(join(other, 'session.v4.jsonl.zstd'), Buffer.alloc(32, 1))
  return { root, projectA, projectB, victim, keep, other }
}

const exists = async (path) => {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

test('assertSessionId accepts real ids and refuses anything path-like', () => {
  assert.equal(assertSessionId('session-37db5b14-5cad-4a2e-826f-31be9e1c1e39'), 'session-37db5b14-5cad-4a2e-826f-31be9e1c1e39')
  assert.equal(assertSessionId('a'), 'a')
  for (const bad of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'C:\\x', 'has space', '-leading', 'x'.repeat(129), 42, null, undefined]) {
    assert.throws(() => assertSessionId(bad), (error) => {
      assert.ok(error instanceof ArchiveManagerError)
      assert.equal(error.code, 'archive-manager/invalid-session-id')
      return true
    }, `expected ${JSON.stringify(bad)} to be refused`)
  }
})

test('directoryStats sums nested files', async () => {
  const { root, victim } = await fixture()
  try {
    await mkdir(join(victim, 'nested'), { recursive: true })
    await writeFile(join(victim, 'nested', 'extra.bin'), Buffer.alloc(100, 3))
    const stats = await directoryStats(victim)
    assert.equal(stats.files, 3)
    assert.equal(stats.bytes, 2100)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('planning sees the session directory without touching it', async () => {
  const { root, victim } = await fixture()
  try {
    const plan = await planDirectoryRemoval('session-victim', victim)
    assert.equal(plan.present, true)
    assert.equal(plan.files, 2)
    assert.equal(plan.bytes, 2000)
    assert.equal(await exists(victim), true)

    const missing = await planDirectoryRemoval('session-victim', join(root, 'nope', 'session-victim'))
    assert.equal(missing.present, false)
    assert.equal(missing.bytes, 0)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removal deletes exactly one session and keeps its siblings', async () => {
  const { root, projectA, projectB, victim, keep, other } = await fixture()
  try {
    const plan = await planSessionRemoval({
      sessionId: 'session-victim',
      logPath: join(victim, 'session.v4.jsonl.zstd'),
    })
    assert.equal(dirname(plan.directory), projectA)
    await removeSessionDirectory(plan.directory)

    assert.equal(await exists(victim), false)
    assert.equal(await exists(keep), true)
    assert.equal(await exists(other), true)
    assert.equal(await exists(projectA), true)
    assert.equal(await exists(projectB), true)
    assert.deepEqual((await readdir(projectA)).sort(), ['session-keep'])
    // The sibling's bytes are untouched.
    assert.equal((await stat(join(keep, 'session.v4.jsonl.zstd'))).size, 64)
    // Removing an already absent directory is idempotent.
    await removeSessionDirectory(plan.directory)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findSessionDirectory locates one session under any project directory', async () => {
  const { root, other } = await fixture()
  try {
    assert.equal(await findSessionDirectory(root, 'session-other'), other)
    assert.equal(await findSessionDirectory(root, 'session-absent'), undefined)
    assert.equal(await findSessionDirectory(undefined, 'session-other'), undefined)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('locateSessionLog prefers the backend and stays optional', async () => {
  const backend = { locate: (meta) => ({ kind: 'jsonl', path: `/logs/${meta.cwd}/${meta.id}/session.v4.jsonl.zstd` }) }
  assert.equal(
    locateSessionLog(backend, { id: 'session-a', cwd: 'C:\\w' }),
    '/logs/C:\\w/session-a/session.v4.jsonl.zstd',
  )
  assert.equal(locateSessionLog(backend, { id: 'session-a' }), '/logs/undefined/session-a/session.v4.jsonl.zstd')
  assert.equal(locateSessionLog(undefined, { id: 'session-a' }), undefined)
  assert.equal(locateSessionLog({}, { id: 'session-a' }), undefined)
  assert.equal(locateSessionLog({ locate: () => { throw new Error('boom') } }, { id: 'session-a' }), undefined)
  assert.equal(locateSessionLog({ locate: () => ({ kind: 'jsonl' }) }, { id: 'session-a' }), undefined)
})

test('a removal plan carries no live file handles and reports the log path', async () => {
  const { root, victim } = await fixture()
  try {
    const plan = await planSessionRemoval({ sessionId: 'session-victim', logPath: join(victim, 'session.v4.jsonl.zstd') })
    assert.equal(plan.sessionId, 'session-victim')
    assert.equal(plan.logPath, join(victim, 'session.v4.jsonl.zstd'))
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
