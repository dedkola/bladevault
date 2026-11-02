import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('selects Alloy in Appearance and keeps its horizontal shell after reload', async ({
  page,
  request,
}) => {
  await page.goto('/settings?tab=appearance')
  const alloy = page.getByRole('radio', { name: /Alloy/ })
  await alloy.click()

  await expect(alloy).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme-style',
    'alloy',
  )
  await expect(page.locator('[data-alloy-shell]')).toBeVisible()
  await expect(page.locator('[data-sidebar]')).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(navigation).toHaveCSS('flex-direction', 'row')
  for (const name of [
    'Collection',
    'Studio',
    'Insights',
    'Compare',
    'Activity',
  ]) {
    await expect(
      navigation.getByRole('link', { name, exact: true }),
    ).toBeVisible()
  }

  await page.reload()
  await expect(alloy).toBeChecked()
  await expect(page.locator('[data-alloy-shell]')).toBeVisible()
  const { settings } = await (await request.get('/api/settings')).json()
  expect(settings.themeStyle).toBe('alloy')
})

test('switches gallery and table while pinning and comparing the selected knife', async ({
  page,
  request,
}) => {
  const { knife } = await seedKnife(request, {
    name: 'Alloy Folder',
    brand: 'Alpha',
    specs: {
      bladeLength: '80 mm',
      weight: '90 g',
      bladeMaterial: '14C28N',
      lockingMechanism: 'Crossbar Lock',
    },
  })
  await seedKnife(request, {
    name: 'Alloy Fixed',
    brand: 'Beta',
    specs: { lockingMechanism: 'Fixed Blade' },
  })
  await request.post('/api/settings', { data: { themeStyle: 'alloy' } })
  await request.post('/api/comparisons', {
    data: { action: 'create', name: 'Alloy carry', ids: [] },
  })
  await page.goto('/collection')
  await page.getByRole('button', { name: 'Gallery view', exact: true }).click()
  await expect(page.locator('[data-alloy-collection-grid]')).toBeVisible()
  await page
    .getByRole('button', { name: 'Inspect Alpha Alloy Folder', exact: true })
    .click()

  const inspector = page.locator('[data-modern-inspector]')
  await expect(inspector).toBeVisible()
  await expect(
    inspector.getByRole('heading', { name: 'Alloy Folder' }),
  ).toBeVisible()
  await inspector.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(
    inspector.getByRole('button', { name: 'Pinned', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  const savedKnife = await (await request.get(`/api/knives/${knife.id}`)).json()
  expect(savedKnife.knife.pinned).toBe(true)

  await inspector.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(
    inspector.getByRole('button', { name: 'In list', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  const comparisons = await (await request.get('/api/comparisons')).json()
  expect(
    comparisons.lists.find(
      (list: { name: string }) => list.name === 'Alloy carry',
    ).ids,
  ).toEqual([knife.id])

  await page.getByRole('button', { name: 'List view', exact: true }).click()
  await expect(page.locator('[data-modern-collection-table]')).toBeVisible()
  await expect(page.locator('[data-alloy-collection-grid]')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-modern-collection-table]')).toContainText(
    'Alloy Folder',
  )
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Compare', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Alloy carry', exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-compare-editing]')).toContainText(
    'Alloy Folder',
  )

  await page.goto(`/collection/${knife.id}`)
  await expect(
    page.getByRole('button', { name: 'Pinned', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByRole('button', { name: 'In 1 list', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Edit Knife', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Pinned', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByRole('button', { name: 'In 1 list', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('keeps Insights and Studio usable through mobile navigation without page overflow', async ({
  page,
  request,
}) => {
  await seedKnife(request, {
    name: 'Mobile Folder',
    brand: 'Alpha',
    specs: {
      bladeLength: '80 mm',
      weight: '90 g',
      bladeMaterial: '14C28N',
      lockingMechanism: 'Crossbar Lock',
    },
  })
  await seedKnife(request, {
    name: 'Mobile Fixed',
    brand: 'Beta',
    specs: { lockingMechanism: 'Fixed Blade' },
  })
  await request.post('/api/settings', { data: { themeStyle: 'alloy' } })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/collection')
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })

  const insights = navigation.getByRole('link', {
    name: 'Insights',
    exact: true,
  })
  await insights.focus()
  await insights.press('Enter')
  await expect(
    page.getByRole('heading', { name: 'Know your collection.', exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-alloy-insights]')).toBeVisible()
  await expect(
    page.getByRole('group', { name: 'Catalogued knives', exact: true }),
  ).toContainText('2')
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)

  const studio = navigation.getByRole('link', { name: 'Studio', exact: true })
  await studio.focus()
  await studio.press('Enter')
  await expect(
    page.getByRole('heading', { name: 'Objects of interest.', exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-studio-tile]')).toHaveCount(2)
  const quickLook = page.getByRole('button', {
    name: 'Quick look: Alpha Mobile Folder',
    exact: true,
  })
  await quickLook.focus()
  await quickLook.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(quickLook).toBeFocused()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
})
