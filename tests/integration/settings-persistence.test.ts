import { afterEach, describe, expect, it } from 'vitest'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import { START_PAGES } from '@/lib/settings-shared'
import Page from '@/app/page'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('settings persistence', () => {
  it('stores price monitoring settings and keeps them across unrelated saves', async () => {
    vault = await createTempVault('bladevault-settings-')

    expect(getSettings().priceMonitoring).toMatchObject({
      enabled: true,
      schedule: { intervalHours: 24 },
    })
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        enabled: false,
        scope: { kind: 'wishlist', knifeIds: ['k1'] },
        collectionPass: { enabled: true, superSalePercent: 40 },
        schedule: { intervalHours: 6, slowOutOfStock: false },
        pacing: { minGapSeconds: 90 },
        notify: {
          drop: true,
          increase: true,
          outOfStock: true,
          backInStock: false,
        },
        thresholds: { minPercent: 2.5, minAmount: 3, allTimeLow: true },
        ai: {
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          model: 'llama3.2',
          headers: { 'x-opencode-session': 'bladevault' },
          extractionFallback: false,
          advisor: true,
          resolveErrors: false,
          vision: false,
          findMovedPages: false,
          autoRelink: true,
          fixVariants: false,
          retryBlocked: false,
          confirmChanges: false,
          spotCheck: true,
          dailyDigest: false,
          maxPageKb: 500,
          maxAnswerTokens: 32_768,
          usage: {
            mode: 'unlimited',
            dailyCalls: 50,
            dailyTokens: 0,
            sourceCooldownHours: 6,
          },
          agentMode: 'observe',
          chat: {
            model: 'qwen3',
            toolMode: 'json',
            reasoning: 'high',
            dailyCalls: 40,
            dailyTokens: 0,
          },
        },
        otherStores: {
          enabled: true,
          stores: {
            bladehq: false,
            smkw: false,
            dlttrading: false,
            knifejoy: false,
            northwestknives: false,
            amazon: false,
          },
        },
      },
    })
    saveSettings({ startPage: 'studio' })
    closeLocalDb()
    expect(getSettings().priceMonitoring).toEqual({
      enabled: false,
      skipSoldKnives: true,
      ignoreOfficialOutOfStock: false,
      scope: { kind: 'wishlist', knifeIds: ['k1'] },
      collectionPass: { enabled: true, superSalePercent: 40 },
      schedule: { intervalHours: 6, slowOutOfStock: false },
      pacing: { minGapSeconds: 90 },
      notify: {
        drop: true,
        increase: true,
        outOfStock: true,
        backInStock: false,
      },
      thresholds: { minPercent: 2.5, minAmount: 3, allTimeLow: true },
      ai: {
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.2',
        headers: { 'x-opencode-session': 'bladevault' },
        extractionFallback: false,
        advisor: true,
        resolveErrors: false,
        vision: false,
        findMovedPages: false,
        autoRelink: true,
        fixVariants: false,
        retryBlocked: false,
        confirmChanges: false,
        spotCheck: true,
        dailyDigest: false,
        maxPageKb: 500,
        maxAnswerTokens: 32_768,
        usage: {
          mode: 'unlimited',
          dailyCalls: 50,
          dailyTokens: 0,
          sourceCooldownHours: 6,
        },
        agentMode: 'observe',
        chat: {
          model: 'qwen3',
          toolMode: 'json',
          reasoning: 'high',
          dailyCalls: 40,
          dailyTokens: 0,
        },
      },
      otherStores: {
        enabled: true,
        stores: {
          bladehq: false,
          smkw: false,
          dlttrading: false,
          knifejoy: false,
          northwestknives: false,
          amazon: false,
        },
      },
    })
    // The AI key is never part of the settings table.
    expect(
      JSON.stringify(
        getLocalDb()
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('price_monitoring'),
      ),
    ).not.toMatch(/apiKey|api_key/i)

    // Settings saved before notifications existed get the defaults.
    getLocalDb()
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run(
        JSON.stringify({ enabled: false, skipSoldKnives: false }),
        'price_monitoring',
      )
    expect(getSettings().priceMonitoring).toMatchObject({
      enabled: false,
      skipSoldKnives: false,
      notify: {
        drop: true,
        increase: false,
        outOfStock: false,
        backInStock: true,
      },
      thresholds: { minPercent: 5, minAmount: 0, allTimeLow: false },
    })

    getLocalDb()
      .prepare("UPDATE settings SET value = '{broken' WHERE key = ?")
      .run('price_monitoring')
    expect(getSettings().priceMonitoring.enabled).toBe(true)
  })

  it('opens Insights for an existing vault without a start-page setting', async () => {
    vault = await createTempVault('bladevault-settings-')

    expect(getSettings().startPage).toBe('insights')
    expect(Page).toThrow(
      expect.objectContaining({
        digest: 'NEXT_REDIRECT;replace;/insights;307;',
      }),
    )
  })

  it.each(START_PAGES)(
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

  it.each(['classic', 'modern', 'alloy'] as const)(
    'stores the %s theme style in SQLite and reloads it after reopening the database',
    async (themeStyle) => {
      vault = await createTempVault('bladevault-settings-')

      saveSettings({ themeStyle })
      const stored = getLocalDb()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('theme_style') as { value: string }
      expect(stored.value).toBe(themeStyle)

      closeLocalDb()
      expect(getSettings().themeStyle).toBe(themeStyle)
    },
  )

  it('persists collection display choices across database reopens and unrelated settings updates', async () => {
    vault = await createTempVault('bladevault-settings-')
    const display = {
      columns: ['status', 'steel'] as const,
      columnWidths: { knife: 240, steel: 120, 'custom:inventory': 180 },
      view: 'grid' as const,
      sort: 'brand' as const,
      density: 'compact' as const,
      columnSort: { key: 'blade', direction: 'desc' as const },
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

  it.each(['in', 'mm', 'both'] as const)(
    'persists the %s dimension display across database reopens and unrelated updates',
    async (dimensionUnit) => {
      vault = await createTempVault('bladevault-settings-')
      expect(getSettings().dimensionUnit).toBe('in')
      saveSettings({ dimensionUnit })
      saveSettings({ theme: 'dark' })
      saveSettings({ dimensionUnit: 'cm' as never })
      closeLocalDb()
      expect(getSettings().dimensionUnit).toBe(dimensionUnit)
      const stored = getLocalDb()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('dimension_unit') as { value: string }
      expect(stored.value).toBe(dimensionUnit)
    },
  )

  it('uses inches when a stored dimension preference is malformed', async () => {
    vault = await createTempVault('bladevault-settings-')
    saveSettings({ dimensionUnit: 'mm' })
    getLocalDb()
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('cm', 'dimension_unit')
    expect(getSettings().dimensionUnit).toBe('in')
  })

  it('stores the knife detail panel width, keeps it across saves, and resets it', async () => {
    vault = await createTempVault('bladevault-settings-')
    expect(getSettings().knifeDetailPanelWidth).toBeNull()

    saveSettings({ knifeDetailPanelWidth: 512.6 })
    expect(getSettings().knifeDetailPanelWidth).toBe(513)
    const stored = getLocalDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('knife_detail_panel_width') as { value: string }
    expect(stored.value).toBe('513')

    saveSettings({ dimensionUnit: 'mm' })
    expect(getSettings().knifeDetailPanelWidth).toBe(513)

    saveSettings({ knifeDetailPanelWidth: null })
    expect(getSettings().knifeDetailPanelWidth).toBeNull()

    getLocalDb()
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('wide', 'knife_detail_panel_width')
    expect(getSettings().knifeDetailPanelWidth).toBeNull()
  })
})
