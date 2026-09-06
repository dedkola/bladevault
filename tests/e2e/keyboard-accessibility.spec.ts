import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('matches collection search against model names only', async ({
  page,
  request,
}) => {
  await seedKnife(request, {
    name: 'Porcupine',
    brand: 'Forest',
    description: 'Raccoon-inspired design',
  })
  await seedKnife(request, {
    name: 'Raccoon',
    brand: 'Forest',
  })
  await page.goto('/collection')

  const search = page.getByPlaceholder('Search model name…')
  await search.fill('raccoon')

  await expect(page.getByTitle('Forest Raccoon')).toBeVisible()
  await expect(page.getByTitle('Forest Porcupine')).not.toBeVisible()
})

test('supports collection search and filter keyboard focus', async ({
  page,
  request,
}) => {
  await seedKnife(request)
  await page.goto('/collection')

  // Exercise a client handler first so the shortcut assertion cannot race hydration.
  await page.getByRole('button', { name: 'Select' }).click()
  await page.getByRole('button', { name: 'Cancel selection' }).click()
  await expect(page.getByRole('button', { name: 'Search knives' })).toHaveCount(
    0,
  )
  const search = page.getByPlaceholder('Search model name…')
  await page.keyboard.press('/')
  await expect(search).toBeFocused()
  await search.fill('bugout')
  await expect(page).toHaveURL(/q=bugout/)
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(page).not.toHaveURL(/q=/)

  const filtersTrigger = page.getByRole('button', {
    name: 'Filters',
    exact: true,
  })
  const filterPanel = page.locator('[data-collection-filter-panel]')
  const brandTrigger = page.getByRole('button', { name: 'Brand', exact: true })

  await expect(filtersTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(brandTrigger).not.toBeVisible()
  expect(
    await filterPanel.evaluate((element) => element.clientHeight),
  ).toBeLessThan(60)

  await filtersTrigger.click()
  await expect(filtersTrigger).toHaveAttribute('aria-expanded', 'true')
  await brandTrigger.click()
  await expect(page.getByPlaceholder('Search brand...')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(brandTrigger).toBeFocused()
  await expect(brandTrigger).toHaveAttribute('aria-expanded', 'false')

  await page.goto('/compare')
  await expect(page.getByRole('button', { name: 'Search knives' })).toHaveCount(
    0,
  )
  const compareSearch = page.getByPlaceholder('Search model name…')
  await page.keyboard.press('/')
  await expect(compareSearch).toBeFocused()
})

test('finds and opens knives from insights and knife details', async ({
  page,
  request,
}) => {
  const bugout = await seedKnife(request)
  const raccoon = await seedKnife(request, {
    name: 'Raccoon',
    brand: 'Vosteed',
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Search knives' }).click()

  const dialog = page.getByRole('dialog', { name: 'Find a knife' })
  const search = dialog.getByRole('combobox', {
    name: 'Find a knife by model name',
  })
  await expect(search).toBeFocused()
  await search.fill('bugout')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`/collection/${bugout.knife.id}`)

  await expect(
    page.getByRole('button', { name: 'Search knives' }),
  ).toBeVisible()
  await page.keyboard.press('/')
  await expect(search).toBeFocused()
  await search.fill('raccoon')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`/collection/${raccoon.knife.id}`)
})

test('shows a detail source link without the redundant product page label', async ({
  page,
  request,
}) => {
  const { knife } = await seedKnife(request, {
    sourceUrl: 'https://example.com/knife',
  })

  await page.goto(`/collection/${knife.id}`)
  await expect(page.getByRole('link', { name: /example\.com/ })).toBeVisible()
  await expect(page.getByText('Product page', { exact: true })).toHaveCount(0)
})

test('navigates the fullscreen gallery with arrow keys', async ({
  page,
  request,
}) => {
  const seeded = await seedKnife(request, {
    imageUrls: [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    ],
  })

  await page.goto(`/collection/${seeded.knife.id}`)
  await page.getByRole('button', { name: 'View fullscreen' }).click()
  await expect(page.getByText('1 of 2', { exact: true })).toBeVisible()

  await page.keyboard.press('ArrowRight')
  await expect(page.getByText('2 of 2', { exact: true })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByText('1 of 2', { exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('button', { name: 'Close image viewer' }),
  ).not.toBeVisible()
})
