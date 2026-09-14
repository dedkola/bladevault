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

test('keeps sparse card actions inside equal-height cards', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await seedKnife(request, {
    name: 'Sparse',
    brand: 'Workshop',
  })
  await seedKnife(request, {
    name: 'Detailed',
    brand: 'Workshop',
    specs: {
      bladeLength: '3.25\" | 82.55 mm',
      bladeMaterial: 'S35VN',
      bladeCoating: 'Satin',
      lockingMechanism: 'Crossbar Lock',
    },
  })

  await page.goto('/collection')
  await page.locator('#collection-sort').selectOption('model')

  const cards = page.locator('[data-knife-card]')
  await expect(cards).toHaveCount(2)
  const metrics = await cards.evaluateAll((items) =>
    items.map((item) => {
      const card = item.querySelector<HTMLElement>('[data-slot="card"]')
      const compare = item.querySelector<HTMLElement>(
        'button[aria-label*="to compare"]',
      )
      if (!card || !compare) throw new Error('Expected card and compare action')

      const articleBounds = item.getBoundingClientRect()
      const cardBounds = card.getBoundingClientRect()
      const compareBounds = compare.getBoundingClientRect()
      return {
        articleHeight: articleBounds.height,
        cardHeight: cardBounds.height,
        cardBottomGap: articleBounds.bottom - cardBounds.bottom,
        compareBottomInset: cardBounds.bottom - compareBounds.bottom,
      }
    }),
  )

  expect(
    Math.max(...metrics.map((metric) => metric.cardHeight)) -
      Math.min(...metrics.map((metric) => metric.cardHeight)),
  ).toBeLessThan(1)
  expect(
    metrics.every(
      (metric) =>
        Math.abs(metric.articleHeight - metric.cardHeight) < 1 &&
        Math.abs(metric.cardBottomGap) < 1 &&
        metric.compareBottomInset >= 0,
    ),
  ).toBe(true)
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
  const familyDialog = page.getByRole('dialog')
  await expect(familyDialog).toBeVisible()
  await expect(
    familyDialog.getByRole('button', {
      name: /Preview Vosteed Parallel A3510/,
    }),
  ).toBeVisible()
  await expect(familyDialog).toContainText(
    'A3510 · 154CM · Titanium · Destroyer Gray',
  )
  await expect(familyDialog).toContainText('A3511 · 154CM · G-10 · Stonewash')
  await expect(familyDialog).not.toContainText('A3506')

  await familyDialog
    .getByRole('button', { name: /Preview Vosteed Parallel A3510/ })
    .click()
  await expect(familyDialog).not.toBeVisible()
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

test('keeps family entries aligned and opens single knives directly', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await seedKnife(request, {
    name: 'Alpha',
    brand: 'Workshop',
    specs: { modelNumber: 'A-1', bladeMaterial: 'S35VN' },
  })
  await seedKnife(request, {
    name: 'Bravo',
    brand: 'Workshop',
    specs: { modelNumber: 'B-1', bladeMaterial: 'S35VN' },
  })
  await seedKnife(request, {
    name: 'Bravo',
    brand: 'Workshop',
    specs: { modelNumber: 'B-2', bladeMaterial: '154CM' },
  })
  await seedKnife(request, {
    name: 'Charlie',
    brand: 'Workshop',
    specs: { modelNumber: 'C-1', bladeMaterial: 'S35VN' },
  })

  await page.goto('/collection?view=families')
  await page.locator('#collection-sort').selectOption('model')

  const entries = page.locator('[data-family-entry]')
  await expect(entries).toHaveCount(3)
  const entryHeights = await entries.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().height),
  )
  expect(Math.max(...entryHeights) - Math.min(...entryHeights)).toBeLessThan(1)

  const familyTrigger = page.getByRole('button', {
    name: 'Workshop Bravo · 2 variants',
  })
  const familyEntry = page.locator('[data-knife-family]')
  const triggerBefore = await familyEntry.boundingBox()
  expect(triggerBefore).not.toBeNull()

  await familyTrigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: /Preview Workshop Bravo B-1/ }),
  ).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: /Preview Workshop Bravo B-2/ }),
  ).toBeVisible()

  const triggerAfter = await familyEntry.boundingBox()
  expect(triggerAfter).not.toBeNull()
  expect(triggerAfter?.x).toBeCloseTo(triggerBefore?.x ?? 0, 0)
  expect(triggerAfter?.y).toBeCloseTo(triggerBefore?.y ?? 0, 0)

  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(familyTrigger).toBeFocused()

  await page.setViewportSize({ width: 768, height: 900 })
  await familyTrigger.click()
  await expect(dialog).toBeVisible()
  const tabletDialogBounds = await dialog.boundingBox()
  expect(tabletDialogBounds).not.toBeNull()
  expect(tabletDialogBounds?.x).toBeGreaterThanOrEqual(15)
  expect(
    768 - ((tabletDialogBounds?.x ?? 0) + (tabletDialogBounds?.width ?? 768)),
  ).toBeGreaterThanOrEqual(15)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()

  await page.setViewportSize({ width: 320, height: 800 })
  const mobileEntryHeights = await entries.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().height),
  )
  expect(
    Math.max(...mobileEntryHeights) - Math.min(...mobileEntryHeights),
  ).toBeLessThan(1)
  await familyTrigger.click()
  await expect(dialog).toBeVisible()
  const variantPositions = await dialog
    .locator('[data-knife-card]')
    .evaluateAll((items) =>
      items.map((item) => {
        const bounds = item.getBoundingClientRect()
        return { x: bounds.x, y: bounds.y }
      }),
    )
  expect(variantPositions).toHaveLength(2)
  expect(variantPositions[0]?.x).toBeCloseTo(variantPositions[1]?.x ?? 0, 0)
  expect(variantPositions[1]?.y).toBeGreaterThan(variantPositions[0]?.y ?? 0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()

  await page.goto('/collection?view=families&bladeMaterial=S35VN')
  await page.locator('#collection-sort').selectOption('model')
  const filteredFamilyTrigger = page.getByRole('button', {
    name: 'Workshop Bravo · 1 of 2 variants match',
  })
  await expect(filteredFamilyTrigger).toBeVisible()
  const filteredEntryHeights = await entries.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().height),
  )
  expect(
    Math.max(...filteredEntryHeights) - Math.min(...filteredEntryHeights),
  ).toBeLessThan(1)
  await filteredFamilyTrigger.click()
  await expect(dialog).toContainText(
    'Showing 1 of 2 variants matching the current filters.',
  )
  await expect(dialog.locator('[data-knife-card]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()

  await page.getByRole('button', { name: 'Preview Workshop Alpha A-1' }).click()
  await expect(page.locator('[data-collection-inspector]')).toContainText(
    'Alpha',
  )
  await expect(page.getByRole('dialog')).toHaveCount(0)
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

test('uses the available desktop width beside the selected knife inspector', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 })

  for (let index = 1; index <= 12; index += 1) {
    await seedKnife(request, {
      name: `Wide ${String(index).padStart(2, '0')}`,
      brand: 'Screen Test',
      specs: { modelNumber: `W-${index}` },
    })
  }

  await page.goto('/collection')
  await page
    .getByRole('button', { name: 'Preview Screen Test Wide 01 W-1' })
    .click()

  const content = page.locator('[data-collection-content]')
  const grid = page.locator('[data-collection-grid]')
  const inspector = page.locator('[data-collection-inspector]')
  await expect(inspector).toBeVisible()

  const [contentBounds, gridBounds, inspectorBounds] = await Promise.all([
    content.boundingBox(),
    grid.boundingBox(),
    inspector.boundingBox(),
  ])
  expect(contentBounds).not.toBeNull()
  expect(gridBounds).not.toBeNull()
  expect(inspectorBounds).not.toBeNull()
  expect(contentBounds?.width).toBeGreaterThan(2000)
  expect(
    (inspectorBounds?.x ?? 0) -
      ((gridBounds?.x ?? 0) + (gridBounds?.width ?? 0)),
  ).toBeLessThanOrEqual(24)

  const firstRowCount = await grid
    .locator(':scope > *')
    .evaluateAll((items) => {
      const firstTop = items[0]?.getBoundingClientRect().top ?? 0
      return items.filter(
        (item) => Math.abs(item.getBoundingClientRect().top - firstTop) < 1,
      ).length
    })
  expect(firstRowCount).toBeGreaterThanOrEqual(5)
  const firstCardBounds = await grid.locator(':scope > *').first().boundingBox()
  expect(firstCardBounds).not.toBeNull()
  expect(firstCardBounds?.width).toBeGreaterThanOrEqual(304)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})
