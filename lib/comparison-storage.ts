import { randomUUID } from 'node:crypto'
import { getLocalDb } from '@/lib/local-db'
import {
  LEGACY_COMPARISON_ID,
  type Comparison,
  type ComparisonCommand,
  type ComparisonResponse,
} from '@/lib/comparisons'

export class ComparisonError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

export function getComparisons(): Comparison[] {
  const db = getLocalDb()
  const rows = db
    .prepare('SELECT * FROM comparison_lists ORDER BY created_at, rowid')
    .all() as Array<{
    id: string
    name: string
    created_at: string
    updated_at: string
    differences_only: number
    revision: number
  }>
  const items = db
    .prepare(
      'SELECT list_id, knife_id FROM comparison_items ORDER BY position DESC',
    )
    .all() as Array<{ list_id: string; knife_id: string }>
  const byList = new Map<string, string[]>()
  for (const item of items) {
    const list = byList.get(item.list_id) ?? []
    list.push(item.knife_id)
    byList.set(item.list_id, list)
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ids: byList.get(r.id) ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    differencesOnly: Boolean(r.differences_only),
    revision: r.revision,
  }))
}

export function mutateComparison(
  command: ComparisonCommand,
): ComparisonResponse {
  const db = getLocalDb()
  return db.transaction(() => {
    let listId: string | undefined
    let undo: ComparisonCommand | undefined
    const now = new Date().toISOString()
    function requireList(id: string, revision?: number) {
      const list = getComparisons().find((l) => l.id === id)
      if (!list)
        throw new ComparisonError(
          'This comparison no longer exists. Choose another list.',
          404,
        )
      if (revision !== undefined && list.revision !== revision)
        throw new ComparisonError(
          'This comparison changed elsewhere. Review the latest list and try again.',
          409,
        )
      return list
    }
    function checkName(name: string, except?: string) {
      if (
        getComparisons().some(
          (l) => l.id !== except && l.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw new ComparisonError(
          'You already have a comparison with this name.',
          409,
        )
    }
    function checkKnives(ids: string[]) {
      const query = db.prepare('SELECT 1 FROM knives WHERE id = ?')
      if (ids.some((id) => !query.get(id)))
        throw new ComparisonError(
          'A selected knife no longer exists. Refresh your collection and try again.',
          404,
        )
    }
    function touch(id: string) {
      db.prepare(
        'UPDATE comparison_lists SET updated_at = ?, revision = revision + 1 WHERE id = ?',
      ).run(now, id)
    }
    function add(id: string, ids: string[]) {
      checkKnives(ids)
      const row = db
        .prepare(
          'SELECT COALESCE(MAX(position), 0) AS position FROM comparison_items WHERE list_id = ?',
        )
        .get(id) as { position: number }
      let position = row.position
      const insert = db.prepare(
        'INSERT OR IGNORE INTO comparison_items (list_id,knife_id,position) VALUES (?,?,?)',
      )
      for (const knifeId of [...new Set(ids)].reverse())
        insert.run(id, knifeId, ++position)
    }
    function insert(list: Comparison) {
      checkName(list.name)
      checkKnives(list.ids)
      db.prepare(
        'INSERT INTO comparison_lists (id,name,name_key,created_at,updated_at,differences_only,revision) VALUES (?,?,?,?,?,?,?)',
      ).run(
        list.id,
        list.name,
        list.name.toLowerCase(),
        list.createdAt,
        now,
        Number(list.differencesOnly),
        list.revision,
      )
      add(list.id, list.ids)
    }
    if (command.action === 'create') {
      listId = randomUUID()
      insert({
        id: listId,
        name: command.name,
        ids: command.ids,
        createdAt: now,
        updatedAt: now,
        differencesOnly: false,
        revision: 0,
      })
    } else if (command.action === 'restore') {
      const existing = getComparisons().find((l) => l.id === command.list.id)
      if (command.expectedRevision === null) {
        if (existing)
          throw new ComparisonError('This comparison already exists.', 409)
        insert({ ...command.list, revision: command.list.revision + 1 })
      } else {
        requireList(command.list.id, command.expectedRevision)
        checkKnives(command.list.ids)
        checkName(command.list.name, command.list.id)
        db.prepare('DELETE FROM comparison_items WHERE list_id = ?').run(
          command.list.id,
        )
        db.prepare(
          'UPDATE comparison_lists SET name = ?, name_key = ?, differences_only = ? WHERE id = ?',
        ).run(
          command.list.name,
          command.list.name.toLowerCase(),
          Number(command.list.differencesOnly),
          command.list.id,
        )
        add(command.list.id, command.list.ids)
        touch(command.list.id)
      }
      listId = command.list.id
    } else if (command.action === 'memberships') {
      checkKnives(command.ids)
      for (const change of command.changes) {
        requireList(change.id, change.expectedRevision)
        if (change.selected) add(change.id, command.ids)
        else
          for (const knifeId of command.ids)
            db.prepare(
              'DELETE FROM comparison_items WHERE list_id = ? AND knife_id = ?',
            ).run(change.id, knifeId)
        touch(change.id)
      }
    } else {
      const list = requireList(command.id, command.expectedRevision)
      listId = list.id
      switch (command.action) {
        case 'rename':
          checkName(command.name, list.id)
          db.prepare(
            'UPDATE comparison_lists SET name = ?, name_key = ? WHERE id = ?',
          ).run(command.name, command.name.toLowerCase(), list.id)
          touch(list.id)
          break
        case 'preference':
          db.prepare(
            'UPDATE comparison_lists SET differences_only = ? WHERE id = ?',
          ).run(Number(command.differencesOnly), list.id)
          touch(list.id)
          break
        case 'duplicate': {
          let name = `${list.name.slice(0, 53)} (copy)`,
            n = 2
          const lists = getComparisons()
          while (lists.some((l) => l.name.toLowerCase() === name.toLowerCase()))
            name = `${list.name.slice(0, 45)} (copy ${n++})`
          listId = randomUUID()
          insert({ ...list, id: listId, name, createdAt: now, revision: 0 })
          break
        }
        case 'delete':
          db.prepare('DELETE FROM comparison_items WHERE list_id = ?').run(
            list.id,
          )
          db.prepare('DELETE FROM comparison_lists WHERE id = ?').run(list.id)
          undo = { action: 'restore', list, expectedRevision: null }
          break
        case 'clear':
          db.prepare('DELETE FROM comparison_items WHERE list_id = ?').run(
            list.id,
          )
          touch(list.id)
          undo = {
            action: 'restore',
            list,
            expectedRevision: list.revision + 1,
          }
          break
        case 'remove':
          for (const id of command.ids)
            db.prepare(
              'DELETE FROM comparison_items WHERE list_id = ? AND knife_id = ?',
            ).run(list.id, id)
          touch(list.id)
          undo = {
            action: 'restore',
            list,
            expectedRevision: list.revision + 1,
          }
          break
        case 'add':
          add(list.id, command.ids)
          touch(list.id)
          break
      }
    }
    return { lists: getComparisons(), listId, undo }
  })()
}

// Legacy API callers have a stable destination, independent of any browser's active list.
export function ensureLegacyComparison() {
  const db = getLocalDb()
  if (!getComparisons().some((l) => l.id === LEGACY_COMPARISON_ID)) {
    let name = 'My comparison',
      suffix = 2
    const lists = getComparisons()
    while (lists.some((l) => l.name.toLowerCase() === name.toLowerCase()))
      name = `My comparison (${suffix++})`
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO comparison_lists (id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run(LEGACY_COMPARISON_ID, name, name.toLowerCase(), now, now)
  }
  return LEGACY_COMPARISON_ID
}
