import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('navigates from an overview block title to its detail page', async ({
  page,
  request,
}) => {
  await seedKnife(request)
  await page.goto('/')

  await page.getByRole('link', { name: 'Data completeness' }).click()
  await expect(page).toHaveURL(/\/insights\/completeness$/)
  await expect(
    page.getByRole('heading', { name: 'Data completeness' }),
  ).toBeVisible()
})
