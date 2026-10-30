import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('uses the table-first collection view in the modern theme', async ({
  page,
  request,
}) => {
  await seedKnife(request, {
    name: 'Modern Table Knife',
    specs: {
      lockingMechanism: 'Fix',
      bladeLength: '3.53" / 89.66mm',
      weight: '3.88oz / 110g',
    },
  })
  await seedKnife(request, {
    name: 'Modern Folder',
    specs: { lockingMechanism: 'Crossbar Lock' },
  })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })

  await page.goto('/collection')

  await expect(page.locator('[data-modern-collection-table]')).toBeVisible()
  await expect(
    page
      .locator('[data-modern-collection-table]')
      .getByText('Modern Table Knife'),
  ).toBeVisible()

  await page
    .getByLabel('Collection type')
    .getByRole('button', { name: 'Fixed', exact: true })
    .click()
  await expect(
    page.locator('[data-modern-collection-table] tbody tr'),
  ).toHaveCount(1)
  await expect(page.locator('[data-modern-collection-table]')).toContainText(
    '3.53 in',
  )
  await expect(page.locator('[data-modern-collection-table]')).toContainText(
    '3.88 oz',
  )
  await page
    .getByLabel('Collection type')
    .getByRole('button', { name: 'All', exact: true })
    .click()

  await page.getByRole('button', { name: 'Gallery view' }).click()
  await expect(page.locator('[data-modern-collection-table]')).toHaveCount(0)
  await expect(page.locator('[data-collection-grid]')).toBeVisible()

  await page.getByRole('button', { name: 'List view' }).click()
  await expect(page.locator('[data-modern-collection-table]')).toBeVisible()

  await page.locator('[data-modern-collection-table] tbody tr').first().click()
  await expect(page.getByRole('link', { name: 'Open knife' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-modern-inspector]')).toHaveCSS(
    'position',
    'fixed',
  )
  const inspectorBounds = await page
    .locator('[data-modern-inspector]')
    .boundingBox()
  expect(inspectorBounds?.y).toBe(64)
  expect(inspectorBounds?.height).toBe(746)
  await page.getByRole('button', { name: 'Close selected knife' }).click()
  await expect(page.locator('[data-modern-inspector]')).toHaveCount(0)
})

test('keeps modern compare inside the workspace shell with saved-list controls and global search', async ({
  page,
  request,
}) => {
  const { knife } = await seedKnife(request, { name: 'Modern Compare Knife' })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })
  await request.post('/api/comparisons', {
    data: { action: 'create', name: 'Everyday', ids: [knife.id] },
  })
  await page.goto('/compare')
  await expect(
    page.getByRole('heading', { name: 'Everyday', exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-workspace-header]')).toHaveCSS(
    'height',
    '58px',
  )
  await expect(
    page
      .locator('[data-compare-tabs]')
      .getByRole('link', { name: 'Everyday 1' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Comparison Matrix' }),
  ).toHaveCount(0)
  await expect(page.getByPlaceholder('Search model name...')).toHaveCount(0)
  await expect(page.locator('[data-compare-editing]')).toContainText(
    'Modern Compare Knife',
  )
  await page.getByRole('button', { name: 'Search knives', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Find a knife by model name' })
    .fill('Modern Compare')
  await expect(page.getByRole('option')).toContainText('Modern Compare Knife')
  await page.getByRole('button', { name: 'Close search' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole('button', { name: 'Open navigation' }),
  ).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
  await page.getByRole('button', { name: 'Search knives', exact: true }).click()
  await expect(
    page.getByRole('combobox', { name: 'Find a knife by model name' }),
  ).toBeVisible()
})

for (const { lock, scope } of [
  { lock: 'Crossbar Lock', scope: 'Fixed' },
  { lock: 'Fixed Blade', scope: 'Folding' },
  { lock: '', scope: 'Fixed' },
  { lock: '', scope: 'Folding' },
]) {
  test(`keeps ${scope} empty with only ${lock || 'unknown locks'}`, async ({
    page,
    request,
  }) => {
    await seedKnife(request, {
      name: 'Unmatched object',
      specs: { lockingMechanism: lock },
    })
    await request.post('/api/settings', { data: { themeStyle: 'modern' } })
    await page.goto('/collection')
    const scopeButton = page
      .getByLabel('Collection type')
      .getByRole('button', { name: scope, exact: true })
    await scopeButton.click()
    await expect(scopeButton).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.getByText('No matches found', { exact: true }),
    ).toBeVisible()
    await expect(page.locator('[data-modern-collection-table]')).toHaveCount(0)
    await page.reload()
    await expect(scopeButton).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.getByText('No matches found', { exact: true }),
    ).toBeVisible()
    await page
      .getByRole('button', { name: 'Clear all', exact: true })
      .last()
      .click()
    await expect(page.locator('[data-modern-collection-table]')).toContainText(
      'Unmatched object',
    )
  })
}

test('distinguishes an empty pinned view from an empty library', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Unpinned object' })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })
  await page.goto('/collection?view=pinned')
  await expect(
    page.getByText('No pinned knives yet', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Your library is empty', { exact: true }),
  ).toHaveCount(0)
  await page
    .getByRole('button', { name: 'View all knives', exact: true })
    .click()
  await expect(page.locator('[data-modern-collection-table]')).toContainText(
    'Unpinned object',
  )
})

test('omits the modern collection header and table hints', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Collection header object' })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })
  await page.goto('/collection')
  await expect(
    page.locator('[data-collection-content] > [data-page-header]'),
  ).toHaveCount(0)
  await page.goto('/collection?q=object')
  await expect(
    page
      .locator('[data-modern-collection-toolbar]')
      .getByRole('button', { name: 'Save smart collection' }),
  ).toBeVisible()
  const table = page.locator('[data-modern-collection-table]')
  await expect(
    table.getByText('Select a row to inspect · double-click to open', {
      exact: true,
    }),
  ).toHaveCount(0)
  await expect(table.getByText('1 knife', { exact: true })).toHaveCount(0)
})

test('persists modern column and view choices and selects rows for bulk actions', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Selected Alpha' })
  await seedKnife(request, { name: 'Selected Beta' })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })
  await request.post('/api/comparisons', {
    data: { action: 'create', name: 'Bulk selection list', ids: [] },
  })
  await page.goto('/collection')
  const table = page.locator('[data-modern-collection-table]')
  const tools = page.locator('[data-modern-collection-tools]')
  await expect(tools.locator(':scope > button').first()).toHaveAttribute(
    'aria-label',
    'Filters and collection tools',
  )
  await page.getByLabel('Choose columns').click()
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/settings') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('checkbox', { name: /^weight$/i }).uncheck()
  await saved
  await expect(table.getByRole('columnheader', { name: 'Weight' })).toHaveCount(
    0,
  )
  await page.getByLabel('Choose columns').click()
  await tools.getByLabel('Sort collection').selectOption('brand')
  await page.getByRole('button', { name: 'Gallery view', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/settings')).json()).settings
          .collectionDisplay.view,
    )
    .toBe('grid')
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Gallery view', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(tools.getByLabel('Sort collection')).toHaveValue('brand')
  await page.getByRole('button', { name: 'List view', exact: true }).click()
  await expect(table.getByRole('columnheader', { name: 'Weight' })).toHaveCount(
    0,
  )
  const inspectorName = await page
    .locator('[data-modern-inspector] h2')
    .textContent()
  await table
    .getByRole('checkbox', { name: 'Select Selected Alpha', exact: true })
    .check()
  await expect(page.locator('[data-modern-inspector] h2')).toHaveText(
    inspectorName!,
  )
  await expect(
    table.getByRole('checkbox', { name: 'Select all matching knives' }),
  ).toHaveAttribute('aria-checked', 'mixed')
  await table
    .getByRole('checkbox', { name: 'Select all matching knives' })
    .check()
  await expect(
    page.getByText('2 knives selected', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Compare selected', exact: true })
    .click()
  await expect
    .poll(async () => {
      const lists = await (await request.get('/api/comparisons')).json()
      return lists.lists.find(
        (list: { name: string }) => list.name === 'Bulk selection list',
      ).ids.length
    })
    .toBe(2)
  await page.getByRole('button', { name: 'Bulk edit', exact: true }).click()
  await page.getByRole('dialog').getByRole('combobox').click()
  await page.getByRole('option', { name: 'Brand / Maker', exact: true }).click()
  await page.getByLabel('New value').fill('Updated maker')
  await page
    .getByRole('button', { name: 'Update 2 knives', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(table.locator('tbody tr')).toContainText([
    'Updated maker',
    'Updated maker',
  ])
  await table
    .getByRole('checkbox', { name: 'Select all matching knives' })
    .check()
  page.once('dialog', (dialog) => dialog.dismiss())
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click()
  await expect(table.locator('tbody tr')).toHaveCount(2)
  page.once('dialog', (dialog) => dialog.accept())
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click()
  await expect(table).toHaveCount(0)
  const data = await (await request.get('/api/knives')).json()
  expect(data.knives).toHaveLength(0)
})

test('shows additional item and custom fields as saved collection columns', async ({
  page,
  request,
}) => {
  await request.post('/api/settings', {
    data: {
      themeStyle: 'modern',
      customFields: [{ id: 'inventory', name: 'Inventory code', type: 'text' }],
    },
  })
  await seedKnife(request, {
    name: 'Column coverage',
    handleMaterial: 'Titanium',
    description: 'A full description from the saved knife.',
    customFields: { inventory: 'VAULT-42' },
    specs: { modelNumber: 'MODEL-42' },
  })
  await page.goto('/collection')
  const table = page.locator('[data-modern-collection-table]')
  await expect(
    table
      .locator('tbody tr')
      .first()
      .locator('td')
      .first()
      .getByRole('checkbox'),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', { name: 'Model Number', exact: true }),
  ).toHaveCount(0)
  await page.getByLabel('Choose columns').click()
  for (const name of [
    'Model Number',
    'Handle Material',
    'Description',
    'Inventory code',
  ]) {
    await page.getByRole('checkbox', { name, exact: true }).check()
  }
  await page.getByLabel('Choose columns').click()
  await expect(table).toContainText('MODEL-42')
  await expect(table).toContainText('Titanium')
  await expect(table).toContainText('VAULT-42')
  await expect(table).toContainText('A full description from the saved knife.')
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/settings')).json()).settings
          .collectionDisplay.columns,
    )
    .toEqual(
      expect.arrayContaining([
        'modelNumber',
        'handleMaterial',
        'description',
        'custom:inventory',
      ]),
    )
  await page.reload()
  await expect(
    table.getByRole('columnheader', { name: 'Inventory code', exact: true }),
  ).toBeVisible()
  await expect(table).toContainText('VAULT-42')
  await page.getByLabel('Choose columns').click()
  await page
    .getByRole('checkbox', { name: 'Inventory code', exact: true })
    .uncheck()
  await expect(
    table.getByRole('columnheader', { name: 'Inventory code', exact: true }),
  ).toHaveCount(0)
})

test('saves dragged column order without reordering collection items', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Column order Alpha', brand: 'Maker Alpha' })
  await seedKnife(request, { name: 'Column order Beta', brand: 'Maker Beta' })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })
  await page.goto('/collection')
  const table = page.locator('[data-modern-collection-table]')
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(2)
  const initialRows = await rows.allTextContents()
  await expect(table.locator('tbody [draggable="true"]')).toHaveCount(0)
  await table
    .getByRole('button', { name: 'Reorder Maker column', exact: true })
    .dragTo(table.getByRole('columnheader', { name: 'Steel', exact: true }))
  await expect(table.locator('thead th').nth(2)).toHaveAccessibleName('Steel')
  await expect(table.locator('thead th').nth(3)).toHaveAccessibleName('Maker')
  await expect(rows.first().locator('td').nth(2)).toContainText('CPM-S30V')
  await expect(rows.first().locator('td').nth(3)).toContainText('Maker')
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/settings')).json()).settings
          .collectionDisplay.columns,
    )
    .toEqual(['steel', 'maker', 'blade', 'weight', 'status'])
  await page.reload()
  await expect(table.locator('thead th').nth(2)).toHaveAccessibleName('Steel')
  await table
    .getByRole('button', { name: 'Reorder Maker column', exact: true })
    .press('ArrowLeft')
  await expect(table.locator('thead th').nth(2)).toHaveAccessibleName('Maker')
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/settings')).json()).settings
          .collectionDisplay.columns,
    )
    .toEqual(['maker', 'steel', 'blade', 'weight', 'status'])
  await expect(rows).toHaveText(initialRows)
  await expect(
    page
      .locator('[data-modern-collection-tools]')
      .getByLabel('Sort collection')
      .locator('option[value="manual"]'),
  ).toHaveCount(0)
})

test('resizes column grips and remembers widths after reload and reorder', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Resizable columns' })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })
  await page.goto('/collection')
  const table = page.locator('[data-modern-collection-table]')
  const header = table.getByRole('columnheader', { name: 'Steel', exact: true })
  const grip = table.getByRole('separator', {
    name: 'Resize Steel column',
    exact: true,
  })
  const start = await grip.boundingBox()
  const originalWidth = (await header.boundingBox())!.width
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    start!.x + start!.width / 2 + 70,
    start!.y + start!.height / 2,
    { steps: 5 },
  )
  await page.mouse.up()
  await expect
    .poll(async () => Math.round((await header.boundingBox())!.width))
    .toBe(Math.round(originalWidth + 70))
  const savedWidth = Math.round((await header.boundingBox())!.width)
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/settings')).json()).settings
          .collectionDisplay.columnWidths.steel,
    )
    .toBe(savedWidth)
  await page.reload()
  await expect
    .poll(async () => Math.round((await header.boundingBox())!.width))
    .toBe(savedWidth)
  await table
    .getByRole('button', { name: 'Reorder Steel column', exact: true })
    .press('ArrowLeft')
  await expect(table.locator('thead th').nth(2)).toHaveAccessibleName('Steel')
  await expect
    .poll(async () => Math.round((await header.boundingBox())!.width))
    .toBe(savedWidth)
  await grip.press('ArrowRight')
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/settings')).json()).settings
          .collectionDisplay.columnWidths.steel,
    )
    .toBe(savedWidth + 10)
  await grip.dblclick()
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/settings')).json()).settings
          .collectionDisplay.columnWidths.steel,
    )
    .toBeUndefined()
})
