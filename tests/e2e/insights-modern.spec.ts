import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })
})

test('summarizes current records and switches between independent measurement distributions', async ({
  page,
  request,
}) => {
  const completeSpecs = {
    bladeLength: '3 in',
    overallLength: '7 in',
    bladeThickness: '3 mm',
    weight: '3 oz',
    bladeMaterial: '14C28N',
    designer: 'Yue',
    lockingMechanism: 'Top Liner Lock',
  }
  await seedKnife(request, {
    name: 'Compact folder',
    brand: 'Alpha',
    bladeStyle: 'Drop Point',
    handleMaterial: 'Micarta',
    specs: completeSpecs,
  })
  await seedKnife(request, {
    name: 'Metric folder',
    brand: 'alpha',
    bladeStyle: 'Drop Point',
    handleMaterial: 'Micarta',
    specs: { ...completeSpecs, bladeLength: '88.9 mm', weight: '141.75 g' },
  })
  await seedKnife(request, {
    name: 'Incomplete record',
    brand: 'Beta',
    bladeStyle: '',
    handleMaterial: '',
    specs: { weight: 'balance' },
  })

  await page.goto('/')
  await expect(
    page
      .getByRole('group', { name: 'Catalogued knives', exact: true })
      .getByText('3', { exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('[data-modern-insights] [data-page-header]'),
  ).toHaveCount(0)
  await expect(
    page
      .getByRole('group', { name: 'Makers', exact: true })
      .getByText('2', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('group', { name: 'Median blade', exact: true }),
  ).toContainText('3.25')
  await expect(
    page.getByRole('group', { name: 'Field coverage', exact: true }),
  ).toContainText(/73\s*%/)
  const measurements = page.getByRole('region', {
    name: 'Measurement distribution',
    exact: true,
  })
  await expect(measurements).toContainText('2 measured · 1 missing')
  await expect(measurements).toContainText('median blade length')
  await measurements
    .getByRole('button', { name: 'Weight', exact: true })
    .click()
  await expect(measurements).toContainText(
    '2 measured · 0 missing · 1 unreadable',
  )
  await expect(measurements).toContainText('median weight')
  const weightBin = measurements.getByRole('button', {
    name: '3.0–3.5 oz: 1 knives, 50% of measured',
    exact: true,
  })
  await weightBin.press('Enter')
  await expect(weightBin).toHaveAttribute('aria-pressed', 'true')
  await expect(measurements).toContainText('3.0–3.5 oz · 1 knives · 50%')
  await measurements
    .getByText('View distribution data', { exact: true })
    .click()
  await expect(measurements.getByRole('table')).toBeVisible()
  await expect(
    measurements.getByRole('row', { name: '3.0–3.5 oz 1 50%' }),
  ).toBeVisible()
  await measurements
    .getByRole('button', { name: 'Overall', exact: true })
    .click()
  await expect(measurements).toContainText('median overall length')
  await expect(measurements).toContainText('Select a range to see its share')
  await measurements
    .getByRole('button', { name: 'Thickness', exact: true })
    .click()
  await expect(measurements).toContainText('median blade thickness')
  await expect(
    measurements.getByRole('link', { name: 'Explore measurements' }),
  ).toHaveAttribute('href', '/insights/measurements?tab=bladeThickness')
  await expect(
    page
      .getByRole('region', { name: 'Catalogue coverage', exact: true })
      .getByText('Filled values across 10 core fields.', { exact: true }),
  ).toBeVisible()

  const makerLink = page
    .getByRole('region', { name: 'Maker mix', exact: true })
    .getByRole('link', { name: /alpha/i })
  const makerHref = await makerLink.getAttribute('href')
  expect(
    new URL(makerHref!, 'http://localhost').searchParams.getAll('brand').sort(),
  ).toEqual(['Alpha', 'alpha'])
  await makerLink.press('Enter')
  const collection = page.locator('[data-modern-collection-table]')
  await expect(collection).toContainText('Compact folder')
  await expect(collection).toContainText('Metric folder')
  await expect(collection).not.toContainText('Incomplete record')
})

test('shows the true all-time history and retains a baseline for shorter ranges', async ({
  page,
  request,
}) => {
  const original = await seedKnife(request, { name: 'Original record' })
  const recent = await seedKnife(request, { name: 'Recent record' })
  const invalid = await seedKnife(request, { name: 'Undated record' })
  const future = await seedKnife(request, { name: 'Future record' })
  const addedDates: Record<string, string> = {
    [original.knife.id]: new Date(2024, 0, 10, 12).toISOString(),
    [recent.knife.id]: new Date(2026, 9, 20, 12).toISOString(),
    [invalid.knife.id]: 'invalid date',
    [future.knife.id]: new Date(2027, 0, 10, 12).toISOString(),
  }
  await page.clock.setFixedTime(new Date(2026, 9, 24, 12))
  // The write API owns addedAt. Override only this isolated browser's read
  // response to exercise old, invalid, and future catalogue dates.
  await page.route('**/api/knives', async (route) => {
    const response = await route.fetch()
    const payload = (await response.json()) as {
      knives: Array<{ id: string; addedAt: string }>
    }
    await route.fulfill({
      response,
      json: {
        ...payload,
        knives: payload.knives.map((knife) => ({
          ...knife,
          addedAt: addedDates[knife.id] ?? knife.addedAt,
        })),
      },
    })
  })

  await page.goto('/')
  const growth = page.getByRole('region', {
    name: 'Collection additions',
    exact: true,
  })
  const sixMonths = page.getByRole('button', {
    name: '6 months',
    exact: true,
  })
  await expect(sixMonths).toHaveAttribute('aria-pressed', 'true')
  await expect(growth).toContainText('+1')
  await expect(growth).toContainText('added in the last 6 months')
  await expect(growth).toContainText('May 2026 – Oct 2026')
  await expect(growth).toContainText('2 invalid or future dates excluded.')
  await growth.getByText('View monthly data', { exact: true }).click()
  await expect(
    growth.getByRole('row', { name: 'May 2026 0 1', exact: true }),
  ).toBeVisible()
  await expect(
    growth.getByRole('row', { name: 'Oct 2026 1 2', exact: true }),
  ).toBeVisible()
  const mayBar = growth.getByRole('button', {
    name: 'May 2026: 0 knives added',
    exact: true,
  })
  await mayBar.press('Enter')
  await expect(mayBar).toHaveAttribute('aria-pressed', 'true')
  await expect(growth).toContainText('May 2026: 0 additions')

  const twelveMonths = page.getByRole('button', {
    name: '12 months',
    exact: true,
  })
  await twelveMonths.click()
  await expect(twelveMonths).toHaveAttribute('aria-pressed', 'true')
  await expect(growth).toContainText('Nov 2025 – Oct 2026')
  await expect(growth).toContainText('added in the last 12 months')
  await expect(growth).toContainText('Oct 2026: 1 additions')

  const allTime = page.getByRole('button', { name: 'All time', exact: true })
  await allTime.click()
  await expect(allTime).toHaveAttribute('aria-pressed', 'true')
  await expect(growth).toContainText('Jan 2024 – Oct 2026')
  await expect(growth).toContainText('+2')
  await expect(growth).toContainText('added since your catalogue began')
  await expect(
    growth.getByRole('row', { name: 'Jan 2024 1 1', exact: true }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('group', { name: 'Catalogued knives', exact: true })
      .getByText('4', { exact: true }),
  ).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  const chartScroll = growth.getByRole('region', {
    name: 'Monthly catalogue additions; scroll to see all ranges',
    exact: true,
  })
  expect(
    await chartScroll.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true)
})

test('distinguishes filled fields from usable measurements and opens missing-record work', async ({
  page,
  request,
}) => {
  await seedKnife(request, {
    name: 'Sparse measurements',
    brand: 'Alpha',
    bladeStyle: 'Drop Point',
    handleMaterial: 'Micarta',
    specs: {
      bladeLength: 'unavailable',
      weight: 'not listed',
      overallLength: '7 in',
      bladeThickness: '3 mm',
      bladeMaterial: '14C28N',
      lockingMechanism: 'Top Liner Lock',
      designer: '',
    },
  })

  await page.goto('/')
  await expect(
    page.getByRole('group', { name: 'Field coverage', exact: true }),
  ).toContainText(/90\s*%/)
  await expect(
    page.getByRole('group', { name: 'Median blade', exact: true }),
  ).toContainText('—')
  const measurements = page.getByRole('region', {
    name: 'Measurement distribution',
    exact: true,
  })
  await expect(measurements).toContainText(
    'No readable blade length measurements yet.',
  )
  await expect(measurements).toContainText(
    '0 measured · 0 missing · 1 unreadable',
  )
  await expect(
    measurements.getByRole('group', {
      name: 'Blade length distribution',
      exact: true,
    }),
  ).toHaveCount(0)
  await measurements
    .getByRole('button', { name: 'Overall', exact: true })
    .click()
  await expect(measurements).toContainText('1 measured · 0 missing')
  await expect(
    measurements.getByRole('group', {
      name: 'Overall length distribution',
      exact: true,
    }),
  ).toBeVisible()
  const missingDesigner = page
    .getByRole('region', { name: 'Catalogue coverage', exact: true })
    .locator('a[href="/collection?designer=__not_set__"]')
  await expect(missingDesigner).toContainText('1 missing')
  await missingDesigner.click()
  await expect(page).toHaveURL(/\/collection\?designer=__not_set__$/)
  await expect(page.locator('[data-modern-collection-table]')).toContainText(
    'Sparse measurements',
  )
})

test('offers a useful first action for an empty catalogue', async ({
  page,
}) => {
  await page.goto('/')
  const addKnife = page.getByRole('link', {
    name: 'Add your first knife',
    exact: true,
  })
  await expect(addKnife).toHaveAttribute('href', '/add')
  await addKnife.click()
  await expect(page).toHaveURL(/\/add$/)
})
