import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('persists the pinned-first setting across reloads', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Appearance' }).click()

  const checkbox = page.getByRole('checkbox').first()
  await expect(checkbox).toBeChecked()
  await checkbox.click()
  await expect(checkbox).not.toBeChecked()

  await page.reload()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await expect(page.getByRole('checkbox').first()).not.toBeChecked()
})

test('persists and applies the selected theme style', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Appearance' }).click()

  const current = page.getByRole('radio', { name: /Classic/ })
  const modern = page.getByRole('radio', { name: /Modern/ })
  await expect(current).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme-style',
    'classic',
  )

  await modern.click()
  await expect(modern).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme-style',
    'modern',
  )
  await expect(
    page.getByRole('heading', { name: 'Appearance', exact: true }),
  ).toBeVisible()

  await page.reload()
  await expect(page.getByRole('radio', { name: /Modern/ })).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme-style',
    'modern',
  )

  await current.click()
  await expect(current).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme-style',
    'classic',
  )
  await expect(
    page.getByRole('heading', { name: 'Appearance', exact: true }),
  ).toBeVisible()
  await page.reload()
  await expect(current).toBeChecked()
})

test('cycles theme styles from the Modern footer', async ({
  page,
  request,
}) => {
  await request.post('/api/settings', { data: { themeStyle: 'lumen' } })
  await page.goto('/collection')

  const html = page.locator('html')
  const themeButton = page.getByRole('button', { name: /^Switch theme\./ })
  await expect(
    page.locator(
      '[data-workspace-footer] button:has(kbd) + [data-theme-cycle]',
    ),
  ).toBeVisible()
  await expect(
    page.locator('[data-workspace-actions] [data-theme-cycle]'),
  ).toHaveCount(0)
  // The palette glyph carries the affordance, so it must not be hidden.
  await expect(themeButton.locator('svg')).toBeVisible()
  await expect(html).toHaveAttribute('data-theme-variant', 'lumen')
  await expect(themeButton).toHaveAttribute(
    'title',
    'Switch theme · Lumen → Espresso',
  )

  await themeButton.click()
  await expect(html).toHaveAttribute('data-theme-variant', 'espresso')
  await expect(themeButton).toHaveAttribute(
    'title',
    'Switch theme · Espresso → Phosphor',
  )

  await themeButton.click()
  await expect(html).toHaveAttribute('data-theme-variant', 'phosphor')
  await expect(html).toHaveClass(/dark/)

  await themeButton.click()
  await expect(html).toHaveAttribute('data-theme-style', 'classic')
  await expect(html).not.toHaveAttribute('data-theme-variant', /.+/)
  await expect(themeButton).toHaveAttribute(
    'title',
    'Switch theme · Classic → Modern',
  )

  await expect
    .poll(async () => {
      const response = await request.get('/api/settings')
      const data = (await response.json()) as {
        settings?: { themeStyle?: string }
      }
      return data.settings?.themeStyle
    })
    .toBe('classic')

  await page.reload()
  await expect(html).toHaveAttribute('data-theme-style', 'classic')
  await expect(themeButton).toHaveAttribute(
    'title',
    'Switch theme · Classic → Modern',
  )
})

test('shows the compact workspace footer in the Classic layout', async ({
  page,
  request,
}) => {
  for (let index = 0; index < 24; index += 1) {
    await seedKnife(request, { name: `Footer scroll ${index}` })
  }
  await page.setViewportSize({ width: 1100, height: 600 })
  await page.goto('/collection')

  const html = page.locator('html')
  const footer = page.locator('[data-workspace-footer]')
  await expect(html).toHaveAttribute('data-theme-style', 'classic')
  await expect(footer).toBeVisible()
  await expect(footer).toContainText('24 knives')
  await expect(
    footer.locator('[data-workspace-footer-actions] [data-footer-action]'),
  ).toHaveCount(3)
  await expect(
    footer
      .locator(
        '[data-workspace-footer-actions] [data-footer-action]:not([aria-label="Toggle color theme"]) svg',
      )
      .first(),
  ).toBeVisible()

  // Classic scrolls the window, so the footer sticks to the viewport edge
  // instead of sitting at the end of a long collection.
  const readGeometry = () =>
    page.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      footerBottom: Math.round(
        document
          .querySelector('[data-workspace-footer]')!
          .getBoundingClientRect().bottom,
      ),
      viewportHeight: window.innerHeight,
      documentScrollable:
        document.documentElement.scrollHeight > window.innerHeight,
    }))

  const atTop = await readGeometry()
  expect(atTop.documentScrollable).toBe(true)
  expect(atTop.footerBottom).toBe(atTop.viewportHeight)

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  )
  const atBottom = await readGeometry()
  expect(atBottom.scrollY).toBeGreaterThan(0)
  expect(atBottom.footerBottom).toBe(atBottom.viewportHeight)

  const themeButton = footer.locator('[data-theme-cycle]')
  await expect(themeButton.locator('svg')).toBeVisible()
  await expect(themeButton).toHaveAttribute(
    'title',
    'Switch theme · Classic → Modern',
  )
  await themeButton.click()
  await expect(html).toHaveAttribute('data-theme-style', 'modern')
})

test('opens the global search from the Classic footer', async ({ page }) => {
  await page.goto('/collection')

  const island = page.locator('[data-global-knife-search]')
  await expect(island).toHaveCount(0)

  await page.locator('[data-workspace-footer] button:has(kbd)').click()
  await expect(island).toBeVisible()
  await expect(
    island.getByRole('combobox', { name: 'Find a knife by model name' }),
  ).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(island).toHaveCount(0)
})

test('persists and applies the selected time format', async ({
  page,
  request,
}) => {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Appearance' }).click()

  const timeFormat = page.getByRole('combobox', { name: 'Time format' })
  const timeFormatValue = timeFormat.locator('[data-slot="select-value"]')
  await expect(timeFormatValue).toHaveText('12-hour')
  await timeFormat.click()
  await page.getByRole('option', { name: '24-hour' }).click()
  await expect(timeFormatValue).toHaveText('24-hour')

  await page.reload()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await expect(
    page
      .getByRole('combobox', { name: 'Time format' })
      .locator('[data-slot="select-value"]'),
  ).toHaveText('24-hour')

  await seedKnife(request, { name: 'Time Format Test' })
  await page.goto('/logs')
  await expect(page.locator('[data-log-entry] time').first()).toHaveText(
    /^\d{1,2} [A-Z][a-z]+ · \d{2}:\d{2}$/,
  )
  await page
    .locator('[data-log-entry]')
    .first()
    .getByRole('button', { name: /details/ })
    .click()
  await expect(
    page.getByRole('region', { name: /Event details for/ }).locator('time'),
  ).toHaveText(/^\d{2}:\d{2}:\d{2}$/)
})

test('prints the collection report from Backup & Restore', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Printable Knife' })
  await page.addInitScript(() => {
    window.print = () => {
      window.sessionStorage.setItem('bladevault-print-requested', 'true')
    }
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0)

  await page.goto('/settings')
  await page.getByRole('button', { name: 'Backup & Restore' }).click()
  await page.getByRole('button', { name: 'Print Report' }).click()

  await expect(page).toHaveURL('/insights')
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sessionStorage.getItem('bladevault-print-requested'),
      ),
    )
    .toBe('true')
})

test('controls MCP access and copies the LM Studio configuration', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/settings?tab=mcp')

  await expect(page.getByText('MCP', { exact: true })).toBeVisible()
  await expect(page.getByText('Activity', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      'Allow local AI clients such as LM Studio to access your BladeVault collection.',
    ),
  ).toHaveCount(0)
  await expect(page.getByText('Endpoint', { exact: true })).toHaveCount(0)

  const access = page.getByRole('checkbox', { name: 'Enable MCP access' })
  const writes = page.getByRole('checkbox', {
    name: 'Allow MCP to modify knives',
  })
  await expect(access).toBeChecked()
  await expect(writes).not.toBeChecked()

  await access.click()
  await expect(access).not.toBeChecked()
  await expect(writes).toBeDisabled()
  expect((await page.request.get('/mcp')).status()).toBe(404)

  await page.reload()
  await expect(access).not.toBeChecked()
  await access.click()
  await expect(access).toBeChecked()

  page.once('dialog', (dialog) => dialog.accept())
  await writes.click()
  await expect(writes).toBeChecked()

  await page.getByRole('button', { name: 'Copy config' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  )
  expect(copied).toMatchObject({
    mcpServers: {
      bladevault: {
        url: 'http://127.0.0.1:3199/mcp',
        headers: {
          Authorization: expect.stringMatching(
            /^Bearer bv_mcp_[A-Za-z0-9_-]{43}$/,
          ),
        },
      },
    },
  })

  const token = copied.mcpServers.bladevault.headers.Authorization.replace(
    'Bearer ',
    '',
  )
  await page.getByRole('button', { name: 'Copy token' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token)

  await page.reload()
  await page.getByRole('button', { name: 'Copy config' }).click()
  const copiedAfterReload = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  )
  expect(copiedAfterReload.mcpServers.bladevault.headers.Authorization).toBe(
    `Bearer ${token}`,
  )
})

test('copies MCP configuration when the modern Clipboard API is unavailable', async ({
  page,
}) => {
  await page.goto('/settings?tab=mcp')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    document.execCommand = (command) => {
      if (command !== 'copy') return false
      const textarea = document.activeElement
      if (!(textarea instanceof HTMLTextAreaElement)) return false
      window.sessionStorage.setItem('fallbackClipboard', textarea.value)
      return true
    }
  })

  await page.getByRole('button', { name: 'Copy config' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()

  const copied = JSON.parse(
    (await page.evaluate(() =>
      window.sessionStorage.getItem('fallbackClipboard'),
    )) || '{}',
  )
  expect(copied).toMatchObject({
    mcpServers: {
      bladevault: {
        url: 'http://127.0.0.1:3199/mcp',
        headers: {
          Authorization: expect.stringMatching(/^Bearer bv_mcp_/),
        },
      },
    },
  })
})

test('saves the start page and keeps Insights accessible', async ({ page }) => {
  for (const startPage of ['collection', 'studio', 'insights']) {
    await page.goto('/settings?tab=appearance')
    const select = page.getByRole('combobox', { name: 'Start page' })
    await select.click()
    await page.getByRole('option', { name: startPage, exact: true }).click()
    await expect(select.locator('[data-slot="select-value"]')).toHaveText(
      startPage,
    )

    await page.reload()
    await expect(
      page
        .getByRole('combobox', { name: 'Start page' })
        .locator('[data-slot="select-value"]'),
    ).toHaveText(startPage)
    await page.goto('/')
    await expect(page).toHaveURL(new RegExp(`/${startPage}$`))
    await page.getByRole('link', { name: 'Insights', exact: true }).click()
    await expect(page).toHaveURL(/\/insights$/)
  }
})

test('audit: keeps every settings tab in the URL through reload and history', async ({
  page,
}) => {
  const tabs = [
    ['general', 'Local storage'],
    ['app-lock', 'App lock'],
    ['cloud-backup', 'Cloud backup'],
    ['restore-database', 'Backup & Restore'],
    ['appearance', 'Appearance'],
    ['fields', 'Custom fields'],
    ['mcp', 'AI / MCP'],
    ['about', 'About'],
  ]
  for (const [id, title] of tabs) {
    await page.goto(`/settings?tab=${id}`)
    await expect(
      page.getByRole('heading', { name: title, exact: true }).first(),
    ).toBeVisible()
  }
  await expect(
    page.getByRole('button', { name: 'Check for updates' }),
  ).toHaveCount(0)
  await expect(
    page.getByText('Automatic updates are available in the desktop app.'),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Backup & Restore', exact: true })
    .click()
  await expect(page).toHaveURL(/tab=restore-database/)
  await page.reload()
  await expect(
    page
      .getByRole('heading', { name: 'Backup & Restore', exact: true })
      .first(),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Custom fields', exact: true }).click()
  await expect(page).toHaveURL(/tab=fields/)
  await page.goBack()
  await expect(
    page
      .getByRole('heading', { name: 'Backup & Restore', exact: true })
      .first(),
  ).toBeVisible()
  await page.goForward()
  await expect(
    page.getByRole('heading', { name: 'Custom fields', exact: true }).first(),
  ).toBeVisible()
})

test('audit: confirms custom-field removal, preserves stored values, and surfaces save failures', async ({
  page,
  request,
}) => {
  await request.post('/api/settings', {
    data: {
      customFields: [{ id: 'inventory', name: 'Inventory', type: 'text' }],
      cardFields: ['custom:inventory'],
      pinnedCardFields: ['custom:inventory'],
    },
  })
  const { knife } = await seedKnife(request, {
    customFields: { inventory: 'SAFE-42' },
  })
  await page.goto('/settings?tab=fields')
  await page.getByRole('button', { name: 'Delete Inventory field' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete Inventory field?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(
    page.getByRole('textbox', { name: 'Name for Inventory field' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Delete Inventory field' }).click()
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST')
      await route.fulfill({
        status: 500,
        json: { error: 'Could not save field changes' },
      })
    else await route.continue()
  })
  await dialog
    .getByRole('button', { name: 'Delete field', exact: true })
    .click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Could not save field changes',
  )
  await expect(dialog).toBeVisible()
  expect(
    (await (await request.get('/api/settings')).json()).settings.customFields,
  ).toHaveLength(1)
  await page.unroute('**/api/settings')
  await dialog
    .getByRole('button', { name: 'Delete field', exact: true })
    .click()
  await expect(dialog).not.toBeVisible()
  const settings = (await (await request.get('/api/settings')).json()).settings
  expect(settings.customFields).toEqual([])
  expect(settings.cardFields).not.toContain('custom:inventory')
  expect(settings.pinnedCardFields).not.toContain('custom:inventory')
  const stored = (await (await request.get(`/api/knives/${knife.id}`)).json())
    .knife
  expect(stored.customFields.inventory).toBe('SAFE-42')
})
