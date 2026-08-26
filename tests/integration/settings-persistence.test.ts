import { afterEach, describe, expect, it } from 'vitest'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('settings persistence', () => {
  it('stores the time format in SQLite and reloads it after reopening the database', async () => {
    vault = await createTempVault('bladevault-settings-')

    saveSettings({ timeFormat: '24h' })
    const stored = getLocalDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('time_format') as { value: string }
    expect(stored.value).toBe('24h')

    closeLocalDb()
    expect(getSettings().timeFormat).toBe('24h')
  })
})
