import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import { createKnife } from '@/tests/fixtures/knife'
import { LocalStorage } from '@/lib/storage/local'
import {
  closeLocalDb,
  getLocalDb,
  LOCAL_DB_SCHEMA_VERSION,
} from '@/lib/local-db'
import { getComparisons, mutateComparison } from '@/lib/comparison-storage'
import { LEGACY_COMPARISON_ID } from '@/lib/comparisons'
import * as route from '@/app/api/comparisons/route'

let vault: TempVault
let storage: LocalStorage
beforeEach(async () => {
  vault = await createTempVault()
  storage = new LocalStorage()
  for (const id of ['first', 'second', 'third'])
    await storage.migrateKnife(createKnife({ id, name: id }), [])
})
afterEach(async () => {
  await vault.cleanup()
})
function create(name: string, ids: string[] = []) {
  const result = mutateComparison({ action: 'create', name, ids })
  return result.lists.find((l) => l.id === result.listId)!
}
function post(body: unknown) {
  return route.POST(
    new Request('http://localhost/api/comparisons', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  )
}

describe('saved comparisons', () => {
  it('migrates legacy order once, filters missing knives, and never resurrects a deleted list', () => {
    const db = getLocalDb()
    db.exec(
      'DROP TABLE comparison_items; DROP TABLE comparison_lists; PRAGMA user_version = 4;',
    )
    const insert = db.prepare('INSERT INTO compare_list VALUES (?,?)')
    insert.run('first', '2026-01-01')
    insert.run('second', '2026-01-01')
    insert.run('missing', '2026-01-02')
    closeLocalDb()
    const [list] = getComparisons()
    expect(list).toMatchObject({
      id: LEGACY_COMPARISON_ID,
      name: 'My comparison',
      ids: ['second', 'first'],
    })
    expect(getLocalDb().pragma('user_version', { simple: true })).toBe(
      LOCAL_DB_SCHEMA_VERSION,
    )
    mutateComparison({ action: 'delete', id: list.id })
    closeLocalDb()
    expect(getComparisons()).toEqual([])
    expect(getLocalDb().prepare('SELECT * FROM compare_list').all()).toEqual([])
  })
  it('starts an empty vault without an unwanted list', () => {
    expect(getComparisons()).toEqual([])
  })
  it('isolates memberships, preserves newest-first ordering and ignores duplicate additions', () => {
    const a = create('Carry', ['first']),
      b = create('Travel', ['first', 'third'])
    mutateComparison({ action: 'add', id: a.id, ids: ['second', 'third'] })
    mutateComparison({ action: 'add', id: a.id, ids: ['first', 'second'] })
    expect(getComparisons().find((l) => l.id === a.id)?.ids).toEqual([
      'second',
      'third',
      'first',
    ])
    const removed = mutateComparison({
      action: 'remove',
      id: a.id,
      ids: ['first'],
    })
    expect(removed.lists.find((l) => l.id === b.id)?.ids).toEqual([
      'first',
      'third',
    ])
    mutateComparison(removed.undo!)
    expect(getComparisons().find((l) => l.id === a.id)?.ids).toEqual([
      'second',
      'third',
      'first',
    ])
  })
  it('updates memberships atomically and rejects stale multi-list selections without partial writes', () => {
    const a = create('Carry'),
      b = create('Travel')
    mutateComparison({ action: 'add', id: b.id, ids: ['third'] })
    expect(() =>
      mutateComparison({
        action: 'memberships',
        ids: ['first'],
        changes: [
          { id: a.id, selected: true, expectedRevision: 0 },
          { id: b.id, selected: true, expectedRevision: 0 },
        ],
      }),
    ).toThrow('changed elsewhere')
    expect(getComparisons().find((l) => l.id === a.id)?.ids).toEqual([])
    mutateComparison({
      action: 'memberships',
      ids: ['first'],
      changes: [
        { id: a.id, selected: true, expectedRevision: 0 },
        { id: b.id, selected: true, expectedRevision: 1 },
      ],
    })
    expect(getComparisons().map((l) => l.ids)).toEqual([
      ['first'],
      ['first', 'third'],
    ])
  })
  it('duplicates preferences, restores deletion and prevents undo from overwriting newer edits', () => {
    const a = create('Carry', ['second', 'first'])
    mutateComparison({ action: 'preference', id: a.id, differencesOnly: true })
    const copied = mutateComparison({ action: 'duplicate', id: a.id })
    expect(copied.lists.find((l) => l.id === copied.listId)).toMatchObject({
      name: 'Carry (copy)',
      ids: a.ids,
      differencesOnly: true,
    })
    const removed = mutateComparison({ action: 'delete', id: a.id })
    mutateComparison(removed.undo!)
    const cleared = mutateComparison({ action: 'clear', id: a.id })
    mutateComparison({ action: 'add', id: a.id, ids: ['third'] })
    expect(() => mutateComparison(cleared.undo!)).toThrow('changed elsewhere')
    expect(getComparisons().find((l) => l.id === a.id)?.ids).toEqual(['third'])
  })
  it('cleans every membership when a knife is deleted, keeping the other knives and empty lists', async () => {
    create('Carry', ['first'])
    create('Travel', ['first', 'second'])
    await storage.deleteKnife('first')
    expect(getComparisons().map((l) => l.ids)).toEqual([[], ['second']])
    expect(getLocalDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('keeps legacy calls on a fixed list without changing other comparisons', async () => {
    const named = create('Personal shortlist', ['third'])
    await storage.addToCompare('first')
    await storage.clearCompareList()
    expect(getComparisons().find((l) => l.id === named.id)?.ids).toEqual([
      'third',
    ])
    expect(await storage.getCompareList()).toEqual([])
  })
  it('validates names, missing destinations/knives, and malformed API requests', async () => {
    const response = await post({
      action: 'create',
      name: '  Carry  ',
      ids: ['first'],
    })
    expect(response.status).toBe(200)
    expect((await response.json()).lists[0].name).toBe('Carry')
    expect((await post({ action: 'create', name: 'carry' })).status).toBe(409)
    expect((await post({ action: 'create', name: ' ' })).status).toBe(400)
    expect(
      (await post({ action: 'create', name: 'x'.repeat(61) })).status,
    ).toBe(400)
    expect(
      (await post({ action: 'add', id: 'missing', ids: ['first'] })).status,
    ).toBe(404)
    const list = getComparisons()[0]
    expect(
      (await post({ action: 'add', id: list.id, ids: ['second', 'missing'] }))
        .status,
    ).toBe(404)
    expect(getComparisons()[0].ids).toEqual(['first'])
    expect(
      (
        await route.POST(
          new Request('http://localhost/api/comparisons', {
            method: 'POST',
            body: '{',
          }),
        )
      ).status,
    ).toBe(400)
  })
})
