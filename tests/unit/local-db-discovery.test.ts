import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearDataDirDiscoveryCache,
  discoverExistingDataDir,
} from '@/lib/local-db'

function createVault(dataDir: string, knives: number) {
  fs.mkdirSync(dataDir, { recursive: true })
  const database = new Database(path.join(dataDir, 'bladevault.sqlite'))
  database.exec('CREATE TABLE IF NOT EXISTS knives (id TEXT)')
  const insert = database.prepare('INSERT INTO knives (id) VALUES (?)')
  for (let index = 0; index < knives; index += 1) insert.run(String(index))
  database.close()
}

describe('data folder discovery', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-discovery-'))
    clearDataDirDiscoveryCache()
  })

  afterEach(() => {
    clearDataDirDiscoveryCache()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('picks the vault with the most knives and does not recount on later lookups', () => {
    const small = path.join(root, 'small')
    const large = path.join(root, 'large')
    const fallback = path.join(root, 'fallback')
    createVault(small, 1)
    createVault(large, 3)

    expect(discoverExistingDataDir([small, large], fallback)).toBe(large)

    // A recount would now prefer the other vault; the cached choice must hold.
    createVault(small, 5)
    expect(discoverExistingDataDir([small, large], fallback)).toBe(large)

    clearDataDirDiscoveryCache()
    expect(discoverExistingDataDir([small, large], fallback)).toBe(small)
  })

  it('discovers again when the cached vault disappears', () => {
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    createVault(first, 2)
    createVault(second, 1)

    expect(discoverExistingDataDir([first, second], root)).toBe(first)
    fs.rmSync(first, { recursive: true, force: true })
    expect(discoverExistingDataDir([first, second], root)).toBe(second)
  })

  it('returns the fallback without caching it when no vault exists', () => {
    const later = path.join(root, 'later')
    const fallback = path.join(root, 'fallback')

    expect(discoverExistingDataDir([later], fallback)).toBe(fallback)
    createVault(later, 1)
    expect(discoverExistingDataDir([later], fallback)).toBe(later)
  })

  it('treats aliases of one database file as a single candidate', () => {
    const vault = path.join(root, 'vault')
    const alias = path.join(root, 'alias')
    createVault(vault, 2)
    fs.symlinkSync(vault, alias)

    expect(discoverExistingDataDir([vault, alias], root)).toBe(vault)
  })
})
