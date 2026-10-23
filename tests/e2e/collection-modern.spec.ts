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

  await expect(page.getByRole('heading', { name: 'All objects' })).toBeVisible()
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
  await expect(page.getByRole('link', { name: 'Open object' })).toBeVisible()
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
