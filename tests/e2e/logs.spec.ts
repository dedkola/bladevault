import { expect, test } from '@playwright/test'
import { resetVault } from './helpers'

function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatShortDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
  }).format(date)
}

function logEntries(page: import('@playwright/test').Page, type?: string) {
  return page.locator(
    type ? `[data-log-entry][data-event-type="${type}"]` : '[data-log-entry]',
  )
}

function logEntry(
  page: import('@playwright/test').Page,
  type: string,
  subject: string,
) {
  return logEntries(page, type).filter({ hasText: subject }).first()
}

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
  await expect(
    page.getByRole('link', { name: 'Logs', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByRole('link', { name: 'Insights', exact: true }),
  ).not.toHaveAttribute('aria-current')
  await expect(logEntry(page, 'created', `${brand} · ${name}`)).toBeVisible()
  await expect(
    logEntry(page, 'created', `${brand} · ${name}`).locator('time'),
  ).toContainText(`${formatShortDate(new Date())} · `)

  await page.goto('/collection')
  await page.getByRole('link', { name: new RegExp(name, 'i') }).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByPlaceholder('e.g. Sebenza 31').fill(updatedName)
  await page.getByRole('button', { name: 'Save Changes' }).click()

  await page.goto('/logs')
  await expect(
    logEntry(page, 'updated', `${brand} · ${updatedName}`),
  ).toBeVisible()

  await page.goto('/collection')
  await page.getByRole('link', { name: new RegExp(updatedName, 'i') }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete' }).click()

  await page.goto('/logs')
  await expect(
    logEntry(page, 'deleted', `${brand} · ${updatedName}`),
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
  await expect(logEntries(page, 'created').first()).toBeVisible()
  await expect(logEntries(page, 'updated')).toHaveCount(0)

  await updatedFilter.click()
  await expect(updatedFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(logEntries(page, 'updated').first()).toBeVisible()
  await expect(logEntries(page, 'deleted')).toHaveCount(0)

  await deletedFilter.click()
  await expect(deletedFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(logEntries(page, 'deleted').first()).toBeVisible()
  await expect(logEntries(page, 'created')).toHaveCount(0)

  await allFilter.click()
  await expect(allFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(logEntries(page, 'created').first()).toBeVisible()
  await expect(logEntries(page, 'updated').first()).toBeVisible()
  await expect(logEntries(page, 'deleted').first()).toBeVisible()

  const dateRangeTrigger = page.getByRole('button', {
    name: 'Filter logs by date range',
  })
  await dateRangeTrigger.click()

  const dateRangePicker = page.getByTestId('log-date-range-picker')
  await expect(dateRangePicker.getByText('Quick ranges')).toBeVisible()
  await expect(dateRangePicker.locator('..')).toHaveCSS('z-index', '50')
  await expect(dateRangePicker.locator('table')).toHaveCount(2)

  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const fromDay = dateRangePicker.locator(
    `[data-day="${formatDateKey(yesterday)}"]:not([data-outside])`,
  )
  const toDay = dateRangePicker.locator(
    `[data-day="${formatDateKey(today)}"]:not([data-outside])`,
  )
  await fromDay.getByRole('button').click()
  await expect(fromDay).toHaveClass(/range-pending/)

  await toDay.getByRole('button').click()
  await expect(fromDay).toHaveClass(/range-start/)
  await expect(toDay).toHaveClass(/range-end/)
  await expect(dateRangePicker.locator('[data-selected]')).toHaveCount(2)
  await expect(dateRangePicker.locator('[data-outside] button')).toHaveCount(0)

  const endpointColor = 'rgb(200, 156, 61)'
  await expect(fromDay.getByRole('button')).toHaveCSS(
    'background-color',
    endpointColor,
  )
  await toDay.getByRole('button').hover()
  await expect(toDay.getByRole('button')).toHaveCSS(
    'background-color',
    endpointColor,
  )
  await dateRangePicker.getByRole('button', { name: 'Apply' }).click()

  await expect(
    page.getByRole('button', { name: /change date range/i }),
  ).toBeVisible()
  await expect(logEntries(page, 'created').first()).toBeVisible()
  await expect(logEntries(page, 'updated').first()).toBeVisible()
  await expect(logEntries(page, 'deleted').first()).toBeVisible()

  await page.getByRole('button', { name: /change date range/i }).click()
  await dateRangePicker.getByRole('button', { name: 'Clear' }).click()
  await expect(dateRangeTrigger).toBeVisible()

  await dateRangeTrigger.click()
  await dateRangePicker.getByRole('button', { name: 'Last 7 days' }).click()
  await page.getByRole('button', { name: /change date range/i }).click()
  await expect(
    dateRangePicker.getByRole('button', { name: 'Last 7 days' }),
  ).toHaveAttribute('aria-pressed', 'true')
})
