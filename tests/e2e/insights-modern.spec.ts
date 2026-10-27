import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })
})

test('summarizes current records and uses only interpreted measurements for the carry profile', async ({
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
    page.getByRole('heading', { name: 'Collection pulse', exact: true }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('group', { name: 'Catalogued knives', exact: true })
      .getByText('3', { exact: true }),
  ).toBeVisible()
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
  await expect(
    page.getByRole('img', {
      name: 'Blade length versus weight for 2 catalogued knives',
      exact: true,
    }),
  ).toBeVisible()
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

  await page.goto('/')
  await page.getByRole('link', { name: 'Open collection', exact: true }).click()
  await expect(page).toHaveURL(/\/collection$/)
  await expect(page.locator('[data-modern-collection-table]')).toContainText(
    'Metric folder',
  )
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
    name: 'Catalogue growth',
    exact: true,
  })
  const sixMonths = page.getByRole('button', {
    name: '6 months',
    exact: true,
  })
  await expect(sixMonths).toHaveAttribute('aria-pressed', 'true')
  await expect(growth).toContainText('2 dated records · 1 added in this range')
  await expect(growth).toContainText('May 2026 – Oct 2026')

  const twelveMonths = page.getByRole('button', {
    name: '12 months',
    exact: true,
  })
  await twelveMonths.click()
  await expect(twelveMonths).toHaveAttribute('aria-pressed', 'true')
  await expect(growth).toContainText('Nov 2025 – Oct 2026')
  await expect(growth).toContainText('2 dated records · 1 added in this range')

  const allTime = page.getByRole('button', { name: 'All time', exact: true })
  await allTime.click()
  await expect(allTime).toHaveAttribute('aria-pressed', 'true')
  await expect(growth).toContainText('Jan 2024 – Oct 2026')
  await expect(growth).toContainText('2 dated records · 2 added in this range')
  await expect(
    page
      .getByRole('group', { name: 'Catalogued knives', exact: true })
      .getByText('4', { exact: true }),
  ).toBeVisible()
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
  const carry = page.getByRole('region', { name: 'Carry profile', exact: true })
  await expect(carry).toContainText(
    'Add blade length and weight to see your carry profile.',
  )
  await expect(carry.getByRole('img')).toHaveCount(0)
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
  await expect(
    page.getByRole('heading', { name: 'Collection pulse', exact: true }),
  ).toBeVisible()
  const addKnife = page.getByRole('link', {
    name: 'Add your first knife',
    exact: true,
  })
  await expect(addKnife).toHaveAttribute('href', '/add')
  await addKnife.click()
  await expect(page).toHaveURL(/\/add$/)
})
