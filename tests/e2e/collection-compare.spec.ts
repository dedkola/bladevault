import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('loads more collection and brand results automatically on scroll', async ({
  page,
  request,
}) => {
  for (let index = 1; index <= 25; index += 1) {
    await seedKnife(request, {
      name: `Infinite ${String(index).padStart(2, '0')}`,
      brand: 'Scroll Brand',
    })
  }
  await seedKnife(request, { name: 'Other', brand: 'Other Brand' })

  const collectionGrid = page.locator('[data-collection-grid]')
  await page.goto('/collection')
  await expect(collectionGrid.locator(':scope > *')).toHaveCount(24)
  await expect(page.getByRole('button', { name: /Load more/ })).toHaveCount(0)
  await page.locator('[data-infinite-scroll-sentinel]').scrollIntoViewIfNeeded()
  await expect(collectionGrid.locator(':scope > *')).toHaveCount(26)

  await page.goto('/collection?brand=Scroll%20Brand')
  await expect(collectionGrid.locator(':scope > *')).toHaveCount(24)
  await page.locator('[data-infinite-scroll-sentinel]').scrollIntoViewIfNeeded()
  await expect(collectionGrid.locator(':scope > *')).toHaveCount(25)
})

test('keeps newest compare item first and filters matching rows', async ({
  page,
  request,
}) => {
  const first = await seedKnife(request, {
    name: 'First',
    brand: 'Alpha',
    specs: { bladeMaterial: 'S30V', country: 'USA' },
  })
  const second = await seedKnife(request, {
    name: 'Second',
    brand: 'Beta',
    specs: { bladeMaterial: 'Magnacut', country: 'USA' },
  })
  await request.post('/api/compare', { data: { id: first.knife.id } })
  await request.post('/api/compare', { data: { id: second.knife.id } })

  await page.goto('/compare')
  const headers = page.getByRole('columnheader')
  await expect(headers).toHaveCount(3)
  await expect(headers.nth(1)).toContainText('Second')
  await expect(headers.nth(2)).toContainText('First')

  await page.getByText('Differences only', { exact: true }).click()
  await expect(page.locator('tbody tr', { hasText: 'Country' })).toHaveCount(0)
  await expect(
    page.locator('tbody tr', { hasText: 'Blade Material' }),
  ).toHaveCount(1)
})

test('groups model variants and switches between their detail pages', async ({
  page,
  request,
}) => {
  const first = await seedKnife(request, {
    name: 'Parallel',
    brand: 'Vosteed',
    handleMaterial: 'Titanium',
    specs: {
      modelNumber: 'A3510',
      bladeMaterial: '154CM',
      bladeCoating: 'Destroyer Gray',
    },
  })
  const second = await seedKnife(request, {
    name: 'Parallel',
    brand: 'Vosteed',
    handleMaterial: 'Titanium',
    specs: {
      modelNumber: 'A3506',
      bladeMaterial: 'S35VN',
      bladeCoating: 'Satin',
    },
  })
  await seedKnife(request, {
    name: 'Parallel',
    brand: 'Vosteed',
    handleMaterial: 'G-10',
    specs: {
      modelNumber: 'A3511',
      bladeMaterial: '154CM',
      bladeCoating: 'Stonewash',
    },
  })
  await seedKnife(request, { name: 'Marten 330', brand: 'Vosteed' })

  await page.goto('/collection?view=families&bladeMaterial=154CM')
  const family = page.locator('[data-knife-family]')
  await expect(
    page.getByRole('button', {
      name: 'Vosteed Parallel · 2 of 3 variants match',
    }),
  ).toBeVisible()
  await page
    .getByRole('button', {
      name: 'Vosteed Parallel · 2 of 3 variants match',
    })
    .click()
  await expect(
    family.getByRole('button', { name: /Preview Vosteed Parallel A3510/ }),
  ).toBeVisible()
  await expect(family).toContainText(
    'A3510 · 154CM · Titanium · Destroyer Gray',
  )
  await expect(family).toContainText('A3511 · 154CM · G-10 · Stonewash')
  await expect(family).not.toContainText('A3506')

  await family
    .getByRole('button', { name: /Preview Vosteed Parallel A3510/ })
    .click()
  const inspector = page.locator('[data-collection-inspector]')
  await expect(inspector).toBeVisible()
  await expect(page).toHaveURL('/collection?view=families&bladeMaterial=154CM')
  await inspector.getByRole('link', { name: 'Open full page →' }).click()
  await expect(page).toHaveURL(`/collection/${first.knife.id}`)
  const firstVariantTrigger = page.getByRole('button', {
    name: /Parallel · 3 variants A3510/,
  })
  await expect(firstVariantTrigger).toHaveAttribute('aria-expanded', 'false')
  await firstVariantTrigger.click()
  await expect(firstVariantTrigger).toHaveAttribute('aria-expanded', 'true')

  const variants = page.getByRole('navigation', { name: 'Model variants' })
  await expect(variants.getByRole('link')).toHaveCount(3)
  await expect(variants.locator('[data-variant-preview]')).toHaveCount(3)
  await variants.getByRole('link', { name: /A3506/ }).click()
  await expect(page).toHaveURL(`/collection/${second.knife.id}`)
  const secondVariantTrigger = page.getByRole('button', {
    name: /Parallel · 3 variants A3506/,
  })
  await expect(secondVariantTrigger).toHaveAttribute('aria-expanded', 'true')
  await expect(variants).toBeVisible()

  await secondVariantTrigger.click()
  await expect(secondVariantTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(variants).not.toBeVisible()
})

test('keeps the selected knife inspector open across collection controls', async ({
  page,
  request,
}) => {
  const first = await seedKnife(request, {
    name: 'Fieldwork',
    brand: 'Quiet Carry',
    specs: { modelNumber: 'FW-01' },
  })
  const second = await seedKnife(request, {
    name: 'Drift',
    brand: 'Quiet Carry',
    pinned: true,
    specs: { modelNumber: 'DR-02' },
  })

  await page.goto('/collection')
  await page
    .getByRole('button', { name: 'Preview Quiet Carry Fieldwork FW-01' })
    .click()

  const inspector = page.locator('[data-collection-inspector]')
  await expect(inspector).toBeVisible()
  await expect(inspector).toContainText('Fieldwork')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByPlaceholder('Search model name…').fill('Drift')
  await expect(page.getByTitle('Quiet Carry Fieldwork')).not.toBeVisible()
  await expect(inspector).toContainText('Fieldwork')

  await page
    .getByRole('navigation', { name: 'Collection grouping' })
    .getByRole('button', { name: 'Pinned 1' })
    .click()
  await expect(inspector).toContainText('Fieldwork')
  await page.getByRole('button', { name: 'Compact view' }).click()
  await expect(page.locator('[data-collection-grid]')).toHaveAttribute(
    'data-density',
    'compact',
  )
  await expect(inspector).toContainText('Fieldwork')

  await page.getByPlaceholder('Search model name…').fill('')
  await page
    .getByRole('button', { name: 'Preview Quiet Carry Drift DR-02' })
    .click()
  await expect(inspector).toContainText('Drift')

  await inspector.getByRole('link', { name: 'Open full page →' }).click()
  await expect(page).toHaveURL(`/collection/${second.knife.id}`)
  await expect(page).not.toHaveURL(`/collection/${first.knife.id}`)
})
