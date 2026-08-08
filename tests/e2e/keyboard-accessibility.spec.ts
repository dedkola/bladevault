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
  await page.keyboard.press('/')
  const search = page.getByPlaceholder('Search model name…')
  await expect(search).toBeFocused()
  await search.fill('bugout')
  await expect(page).toHaveURL(/q=bugout/)
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(page).not.toHaveURL(/q=/)

  const brandTrigger = page.getByRole('button', { name: 'Brand', exact: true })
  await brandTrigger.click()
  await expect(page.getByPlaceholder('Search brand...')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(brandTrigger).toBeFocused()
  await expect(brandTrigger).toHaveAttribute('aria-expanded', 'false')
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
