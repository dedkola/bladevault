import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('renders the modern Collection pulse dashboard from current data', async ({
  page,
  request,
}) => {
  await seedKnife(request, {
    name: 'Modern Insights Folder',
    brand: 'Vosteed',
    bladeStyle: 'Drop Point',
    handleMaterial: 'Micarta',
    specs: {
      bladeLength: '3.25 in',
      bladeMaterial: '14C28N',
      designer: 'Yue',
      lockingMechanism: 'Top Liner Lock',
    },
  })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })

  await page.goto('/')

  await expect(
    page.getByRole('heading', { name: 'Collection pulse' }),
  ).toBeVisible()
  await expect(page.getByText('Catalogued over time')).toBeVisible()
  await expect(page.getByText('Steel DNA')).toBeVisible()
  await expect(page.getByText('Maker mix')).toBeVisible()
  await expect(page.getByText('Family density')).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Explore the collection' }),
  ).toBeVisible()

  const allTime = page.getByRole('button', { name: 'All time' })
  await allTime.click()
  await expect(allTime).toHaveAttribute('aria-pressed', 'true')
})
