import { randomUUID } from 'node:crypto'
import { getLocalDb } from '@/lib/local-db'
import type { SmartCollection } from '@/lib/smart-collections'

const prefix = 'smart_collection:'
export function getSmartCollections(): SmartCollection[] {
  const rows = getLocalDb()
    .prepare(
      'SELECT value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY rowid',
    )
    .all(prefix.length, prefix) as { value: string }[]
  return rows.map((row) => JSON.parse(row.value) as SmartCollection)
}
export function saveSmartCollection(input: {
  id?: string
  name: string
  query: string
}): SmartCollection | null {
  const db = getLocalDb()
  const collection = { ...input, id: input.id ?? randomUUID() }
  if (input.id) {
    const result = db
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run(JSON.stringify(collection), prefix + input.id)
    return result.changes ? collection : null
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    prefix + collection.id,
    JSON.stringify(collection),
  )
  return collection
}
export function deleteSmartCollection(id: string): boolean {
  return (
    getLocalDb()
      .prepare('DELETE FROM settings WHERE key = ?')
      .run(prefix + id).changes > 0
  )
}
