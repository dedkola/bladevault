import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('adds, reloads, edits, and deletes a knife through the UI', async ({
  page,
}) => {
  await page.goto('/add')
  await page.getByRole('tab', { name: 'Manual' }).click()
  await page.getByPlaceholder('e.g. Chris Reeve Knives').fill('Test Maker')
  await page.getByPlaceholder('e.g. Sebenza 31').fill('Test Knife')
  await page.getByPlaceholder('e.g. AEB-L').fill('Magnacut')
  await page.getByRole('button', { name: 'Save Item' }).click()

  await expect(page).toHaveURL(/\/collection$/)
  await expect(page.getByText('Test Knife', { exact: true })).toBeVisible()

  await page.reload()
  await page
    .getByRole('button', { name: /Preview Test Maker Test Knife/ })
    .click()
  await page
    .locator('[data-collection-inspector]')
    .getByRole('link', { name: 'Open full page →' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Test Maker Test Knife' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByPlaceholder('e.g. Sebenza 31').fill('Test Knife Updated')
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expect(
    page.getByRole('heading', { name: 'Test Maker Test Knife Updated' }),
  ).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(/\/collection$/)
  await expect(
    page.getByText('Your library is empty', { exact: true }),
  ).toBeVisible()
})

test('fills only blank edit fields and keeps overwrite as an explicit choice', async ({
  page,
  request,
}) => {
  const original = {
    name: 'Curated Knife',
    brand: 'Curated Maker',
    bladeStyle: 'Drop Point',
    handleMaterial: 'G10',
    description: 'Manually corrected description',
    sourceUrl: 'https://example.com/original',
    specs: {
      weight: '2 oz',
      overallLength: '7 in',
      bladeLength: '3 in',
      bladeThickness: '.090 inches',
      bladeCoating: '',
      bladeMaterial: 'Vanax',
      lockingMechanism: 'Crossbar Lock',
      designer: '   ',
      modelNumber: 'A1001',
      handleLength: '4 in',
      hardness: '60 HRC',
      price: '$200',
      country: 'USA',
    },
  }
  const imported = {
    name: 'Imported Knife',
    brand: 'Imported Maker',
    bladeStyle: 'Tanto',
    handleMaterial: 'Titanium',
    description: 'Retailer description',
    sourceUrl: 'https://example.com/refreshed',
    images: [],
    specs: {
      weight: '3 oz',
      overallLength: '8 in',
      bladeLength: '4 in',
      bladeThickness: '3 mm',
      bladeCoating: 'Satin',
      bladeMaterial: 'M390',
      lockingMechanism: 'Frame Lock',
      designer: 'Imported Designer',
      modelNumber: 'A2002',
      handleLength: '5 in',
      hardness: '62 HRC',
      price: '',
      country: 'China',
    },
  }
  const { knife } = await seedKnife(request, original)
  await page.route('**/api/scrape', (route) =>
    route.fulfill({ json: { product: imported } }),
  )
  await page.goto(`/collection/${knife.id}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Product URL' })
    .fill(imported.sourceUrl)
  await page.getByRole('button', { name: 'Scrape', exact: true }).click()

  await expect(page.getByRole('textbox', { name: 'Model Name' })).toHaveValue(
    original.name,
  )
  await page.getByRole('button', { name: 'Fill empty fields' }).click()
  await expect(
    page.getByRole('textbox', { name: 'Brand / Maker' }),
  ).toHaveValue(original.brand)
  await expect(
    page.getByRole('textbox', { name: 'Blade Material' }),
  ).toHaveValue(original.specs.bladeMaterial)
  await expect(page.getByRole('textbox', { name: 'Designer' })).toHaveValue(
    imported.specs.designer,
  )
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expect(
    page.getByRole('button', { name: 'Edit', exact: true }),
  ).toBeVisible()
  const filled = await (await request.get(`/api/knives/${knife.id}`)).json()
  expect(filled.knife).toMatchObject({
    ...original,
    specs: {
      ...original.specs,
      bladeCoating: imported.specs.bladeCoating,
      designer: imported.specs.designer,
    },
    images: [],
  })

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Product URL' })
    .fill(imported.sourceUrl)
  await page.getByRole('button', { name: 'Scrape', exact: true }).click()
  await page.getByRole('button', { name: 'Overwrite all fields' }).click()
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expect(
    page.getByRole('button', { name: 'Edit', exact: true }),
  ).toBeVisible()
  const overwritten = await (
    await request.get(`/api/knives/${knife.id}`)
  ).json()
  expect(overwritten.knife).toMatchObject(imported)
})
