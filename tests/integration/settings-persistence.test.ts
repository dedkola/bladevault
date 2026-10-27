import { afterEach, describe, expect, it } from 'vitest'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import Page from '@/app/page'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('settings persistence', () => {
  it('opens Insights for an existing vault without a start-page setting', async () => {
    vault = await createTempVault('bladevault-settings-')

    expect(getSettings().startPage).toBe('insights')
    expect(Page).toThrow(
      expect.objectContaining({
        digest: 'NEXT_REDIRECT;replace;/insights;307;',
      }),
    )
  })

  it.each(['insights', 'studio', 'collection'] as const)(
    'persists %s as the start page and uses it when opening the app',
    async (startPage) => {
      vault = await createTempVault('bladevault-settings-')

      saveSettings({ startPage })
      const stored = getLocalDb()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('start_page') as { value: string }
      expect(stored.value).toBe(startPage)

      closeLocalDb()
      expect(getSettings().startPage).toBe(startPage)
      expect(Page).toThrow(
        expect.objectContaining({
          digest: `NEXT_REDIRECT;replace;/${startPage};307;`,
        }),
      )
    },
  )

  it('preserves the saved start page for invalid or unrelated updates', async () => {
    vault = await createTempVault('bladevault-settings-')
    saveSettings({ startPage: 'collection' })
    saveSettings({ theme: 'dark' })
    saveSettings({ startPage: '/untrusted' as never })
    expect(getSettings().startPage).toBe('collection')

    getLocalDb()
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('unknown', 'start_page')
    expect(getSettings().startPage).toBe('insights')
  })

  it('stores the theme style in SQLite and reloads it after reopening the database', async () => {
    vault = await createTempVault('bladevault-settings-')

    saveSettings({ themeStyle: 'modern' })
    const stored = getLocalDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('theme_style') as { value: string }
    expect(stored.value).toBe('modern')

    closeLocalDb()
    expect(getSettings().themeStyle).toBe('modern')
  })

  it('persists collection display choices across database reopens and unrelated settings updates', async () => {
    vault = await createTempVault('bladevault-settings-')
    const display = {
      columns: ['status', 'steel'] as const,
      columnWidths: { knife: 240, steel: 120, 'custom:inventory': 180 },
      view: 'grid' as const,
      sort: 'brand' as const,
      density: 'compact' as const,
    }
    saveSettings({
      collectionDisplay: { ...display, columns: [...display.columns] },
    })
    saveSettings({ theme: 'dark' })
    closeLocalDb()
    expect(getSettings().collectionDisplay).toEqual(display)
    const stored = getLocalDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('collection_display') as { value: string }
    expect(JSON.parse(stored.value)).toEqual(display)
  })

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
