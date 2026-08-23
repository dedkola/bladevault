import { expect, test } from '@playwright/test'
import { resetVault } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('records and displays create, update, and delete events', async ({
  page,
}) => {
  const brand = 'Logs Test Maker'
  const name = 'Logs Test Knife'
  const updatedName = 'Logs Test Knife Updated'

  await page.goto('/add')
  await page.getByRole('tab', { name: 'Manual' }).click()
  await page.getByPlaceholder('e.g. Chris Reeve Knives').fill(brand)
  await page.getByPlaceholder('e.g. Sebenza 31').fill(name)
  await page.getByPlaceholder('e.g. AEB-L').fill('Magnacut')
  await page.getByRole('button', { name: 'Save Item' }).click()

  await expect(page).toHaveURL(/\/collection$/)

  await page.goto('/')
  await page.getByRole('link', { name: 'Logs', exact: true }).click()
  await expect(page).toHaveURL(/\/logs$/)
  await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible()
  await expect(page.getByText(`${brand} · ${name}`)).toBeVisible()

  await page.goto('/collection')
  await page.getByRole('link', { name: new RegExp(name, 'i') }).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByPlaceholder('e.g. Sebenza 31').fill(updatedName)
  await page.getByRole('button', { name: 'Save Changes' }).click()

  await page.goto('/logs')
  await expect(page.getByText(`${brand} · ${updatedName}`)).toBeVisible()

  await page.goto('/collection')
  await page.getByRole('link', { name: new RegExp(updatedName, 'i') }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete' }).click()

  await page.goto('/logs')
  await expect(page.getByText('Knife deleted')).toBeVisible()
  await expect(
    page.getByText(`${brand} · ${updatedName}`).first(),
  ).toBeVisible()

  const allFilter = page.getByRole('button', { name: 'all', exact: true })
  const createdFilter = page.getByRole('button', {
    name: 'created',
    exact: true,
  })
  const updatedFilter = page.getByRole('button', {
    name: 'updated',
    exact: true,
  })
  const deletedFilter = page.getByRole('button', {
    name: 'deleted',
    exact: true,
  })

  await expect(
    page.getByRole('button', { name: 'system', exact: true }),
  ).toHaveCount(0)

  await createdFilter.click()
  await expect(createdFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Knife added')).toBeVisible()
  await expect(page.getByText('Metadata updated')).toHaveCount(0)

  await updatedFilter.click()
  await expect(updatedFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Metadata updated')).toBeVisible()
  await expect(page.getByText('Knife deleted')).toHaveCount(0)

  await deletedFilter.click()
  await expect(deletedFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Knife deleted')).toBeVisible()
  await expect(page.getByText('Knife added')).toHaveCount(0)

  await allFilter.click()
  await expect(allFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Knife added')).toBeVisible()
  await expect(page.getByText('Metadata updated')).toBeVisible()
  await expect(page.getByText('Knife deleted')).toBeVisible()
})
