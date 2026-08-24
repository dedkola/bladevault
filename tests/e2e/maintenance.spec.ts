import { expect, Page, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

function timelineLocator(page: Page) {
  return page.locator('main').locator('ul')
}

test('logs maintenance events from the knife detail page', async ({
  page,
  request,
}) => {
  const { knife } = await seedKnife(request)
  await page.goto(`/collection/${knife.id}`)

  await expect(
    page.getByRole('heading', { name: 'Benchmade Bugout' }),
  ).toBeVisible()
  await expect(
    page.getByRole('main').getByText('Maintenance', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('No maintenance recorded yet', { exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Cleaned' }).click()
  await expect(
    page.getByText('No maintenance recorded yet', { exact: true }),
  ).not.toBeVisible()
  await expect(
    timelineLocator(page).getByText('Cleaned', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Last cleaned')).toBeVisible()

  await page.getByRole('button', { name: 'Sharpened' }).click()
  await expect(page.getByText('Last sharpened')).toBeVisible()

  await page.getByRole('button', { name: 'Add maintenance' }).click()
  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Lubricated' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(
    timelineLocator(page).getByText('Lubricated', { exact: true }),
  ).toBeVisible()

  await page.reload()
  await expect(
    timelineLocator(page).getByText('Cleaned', { exact: true }),
  ).toBeVisible()
  await expect(
    timelineLocator(page).getByText('Lubricated', { exact: true }),
  ).toBeVisible()
  await expect(
    timelineLocator(page).getByText('Sharpened', { exact: true }),
  ).toBeVisible()

  await page.goto('/insights/activity')
  await expect(
    page.getByRole('heading', { name: 'Collection activity' }),
  ).toBeVisible()
  await expect(page.getByText(/1 knife maintained/).first()).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Maintained' }).first(),
  ).toBeVisible()

  await page.goto('/logs')
  const maintenanceEntries = page
    .locator('[data-log-entry]')
    .filter({ hasText: 'Maintenance logged' })
  await expect(maintenanceEntries).toHaveCount(3)
  await expect(
    maintenanceEntries
      .first()
      .getByText('Maintenance', { exact: true })
      .first(),
  ).toBeVisible()
})

test('edits and deletes maintenance events', async ({ page, request }) => {
  const { knife } = await seedKnife(request)
  await page.goto(`/collection/${knife.id}`)

  await page.getByRole('button', { name: 'Cleaned' }).click()
  await expect(
    timelineLocator(page).getByText('Cleaned', { exact: true }),
  ).toBeVisible()

  await page
    .getByRole('button', { name: 'Edit maintenance entry' })
    .first()
    .click()
  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Lubricated' }).click()
  await page.getByRole('textbox', { name: 'Notes' }).fill('Changed the oil')
  await page.getByRole('button', { name: 'Save changes' }).click()

  await expect(
    timelineLocator(page).getByText('Lubricated', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Changed the oil')).toBeVisible()
  await expect(
    timelineLocator(page).getByText('Cleaned', { exact: true }),
  ).not.toBeVisible()

  await page.reload()
  await expect(
    timelineLocator(page).getByText('Lubricated', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Changed the oil')).toBeVisible()

  page.on('dialog', (dialog) => dialog.accept())
  await page
    .getByRole('button', { name: 'Delete maintenance entry' })
    .first()
    .click()
  await expect(
    page.getByText('No maintenance recorded yet', { exact: true }),
  ).toBeVisible()

  await page.reload()
  await expect(
    page.getByText('No maintenance recorded yet', { exact: true }),
  ).toBeVisible()
})

test('keeps the maintenance controls in place after a quick add', async ({
  page,
  request,
}) => {
  const { knife } = await seedKnife(request)

  for (let day = 1; day <= 12; day += 1) {
    const response = await request.post(`/api/knives/${knife.id}/maintenance`, {
      data: {
        type: 'cleaning',
        occurredAt: `2026-07-${String(day).padStart(2, '0')}T12:00:00.000Z`,
      },
    })
    expect(response.ok()).toBe(true)
  }

  await page.goto(`/collection/${knife.id}`)
  const main = page.getByRole('main')
  const quickAdd = page.getByRole('button', { name: 'Cleaned' })
  await quickAdd.scrollIntoViewIfNeeded()
  const scrollTopBefore = await main.evaluate((element) => element.scrollTop)

  await quickAdd.click()
  await expect(timelineLocator(page).locator('li')).toHaveCount(13)

  const scrollTopAfter = await main.evaluate((element) => element.scrollTop)
  expect(Math.abs(scrollTopAfter - scrollTopBefore)).toBeLessThanOrEqual(1)
  await expect(quickAdd).toBeFocused()
})
