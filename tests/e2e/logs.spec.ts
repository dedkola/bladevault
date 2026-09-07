import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

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

test('shows logs last in the primary sidebar navigation', async ({ page }) => {
  await page.goto('/')

  const primaryLinks = page.locator('aside:visible nav > a')
  await expect(primaryLinks).toHaveText([
    'Insights',
    'Collection',
    'Compare',
    'Logs',
  ])
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
  await expect(
    page.getByRole('heading', { name: 'Logs', exact: true }),
  ).toBeVisible()
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

  const allFilter = page.getByRole('button', {
    name: 'All activity',
    exact: true,
  })
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

  const search = page.getByRole('textbox', { name: 'Search logs' })
  const searchWidthBefore = await search.evaluate(
    (element) => element.getBoundingClientRect().width,
  )
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
  await expect(dateRangePicker.locator('[data-selected] button')).toHaveCount(2)
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
  const searchWidthAfter = await search.evaluate(
    (element) => element.getBoundingClientRect().width,
  )
  expect(searchWidthAfter).toBe(searchWidthBefore)
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

test('inspects real log changes inline at all screen sizes', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const { knife } = await seedKnife(request, { name: 'Panel Test Knife' })
  const longNotes = 'A detailed maintenance and collection note. '.repeat(20)
  const update = await request.patch(`/api/knives/${knife.id}`, {
    data: { description: longNotes },
  })
  expect(update.ok()).toBe(true)
  await page.goto('/logs')

  const updated = logEntry(page, 'updated', 'Panel Test Knife')
  const expand = updated.getByRole('button', {
    name: /Metadata updated details/,
  })
  const panel = page.getByRole('complementary', { name: /Event details for/ })
  await expand.click()

  const inlineDetails = page.getByRole('region', {
    name: /Event details for/,
  })
  await expect(inlineDetails).toBeVisible()
  await expect(panel).toHaveCount(0)
  await expect(
    inlineDetails.getByText(longNotes, { exact: true }),
  ).toBeVisible()
  await expect(
    inlineDetails.getByText('Lightweight folder', { exact: true }),
  ).toBeVisible()
  await expect(
    inlineDetails.getByRole('link', { name: 'Open knife details' }),
  ).toHaveAttribute('href', `/collection/${knife.id}`)

  await inlineDetails
    .getByRole('button', { name: 'Close event details' })
    .click()
  await expect(inlineDetails).toHaveCount(0)
  await expect(expand).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(inlineDetails).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(inlineDetails).toHaveCount(0)
  await expect(expand).toBeFocused()
  await expand.click()

  const search = page.getByRole('textbox', { name: 'Search logs' })
  await search.fill('detailed maintenance and collection note')
  await expect(logEntries(page)).toHaveCount(1)
  await expect(inlineDetails).toBeVisible()
  await search.fill('no matching knife or field')
  await expect(
    page.getByText('No matching entries', { exact: true }),
  ).toBeVisible()
  await expect(inlineDetails).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  const postFilterUpdated = logEntry(page, 'updated', 'Panel Test Knife')
  await expect(postFilterUpdated).toBeVisible()
  await expect(inlineDetails).toBeVisible()

  for (const width of [1024, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const loopDetails = page.getByRole('region', {
      name: /Event details for/,
    })
    await expect(loopDetails).toBeVisible()
    await expect(panel).toHaveCount(0)
    await expect(
      loopDetails.getByText(longNotes, { exact: true }),
    ).toBeVisible()
    const geometry = await page.evaluate(() => {
      const main = document.querySelector('main')!
      const table = document.querySelector('[data-slot="table-container"]')!
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
        mainWidth: main.clientWidth,
        mainScroll: main.scrollWidth,
        tableWidth: table.clientWidth,
        tableScroll: table.scrollWidth,
      }
    })
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport)
    expect(geometry.mainScroll).toBeLessThanOrEqual(geometry.mainWidth)
    expect(geometry.tableScroll).toBeLessThanOrEqual(geometry.tableWidth)
  }
  await page
    .getByRole('region', { name: /Event details for/ })
    .getByRole('button', { name: 'Close event details' })
    .click()
  await expect(expand).toBeFocused()
  await updated.getByRole('link', { name: /View Benchmade/ }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${knife.id}$`))
  await page.goto('/logs')
  await expect(updated).toBeVisible()
})

test('keeps the clicked event stationary while switching inline details', async ({
  page,
  request,
}) => {
  for (let index = 0; index < 8; index += 1) {
    await seedKnife(request, { name: `Scroll filler ${index}` })
  }
  const { knife: targetKnife } = await seedKnife(request, {
    name: 'Scroll target',
  })
  const { knife: upperKnife } = await seedKnife(request, {
    name: 'Expanded above target',
  })
  const update = await request.patch(`/api/knives/${upperKnife.id}`, {
    data: { description: 'Long detail value. '.repeat(80) },
  })
  expect(update.ok()).toBe(true)

  await page.setViewportSize({ width: 1440, height: 700 })
  await page.goto('/logs')

  const upperEntry = logEntry(page, 'updated', 'Expanded above target')
  await upperEntry.getByRole('button', { name: /Expand .* details/ }).click()

  const targetEntry = logEntry(page, 'created', 'Scroll target')
  await targetEntry.scrollIntoViewIfNeeded()
  const before = await targetEntry.boundingBox()
  await targetEntry.getByRole('button', { name: /Expand .* details/ }).click()

  const details = page.getByRole('region', {
    name: `Event details for Benchmade · Scroll target`,
  })
  await expect(details).toBeVisible()
  const after = await targetEntry.boundingBox()
  const detailBounds = await details.boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
  expect(detailBounds!.y).toBeGreaterThanOrEqual(after!.y + after!.height - 1)

  await targetEntry.getByRole('button', { name: /Collapse .* details/ }).click()
  const afterCollapse = await targetEntry.boundingBox()
  expect(Math.abs(afterCollapse!.y - after!.y)).toBeLessThanOrEqual(1)
  await expect(details).toHaveCount(0)
  await expect(targetEntry.getByRole('button')).toBeFocused()
  await expect(
    page.getByRole('link', { name: `View Benchmade · Scroll target` }),
  ).toHaveAttribute('href', `/collection/${targetKnife.id}`)
})

test('retries a failed log request and renders an empty vault', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Retry Test Knife' })
  let fail = true
  await page.route('**/api/logs', async (route) => {
    if (fail) {
      await route.fulfill({
        status: 503,
        json: { error: 'Logs are temporarily unavailable.' },
      })
    } else {
      await route.continue()
    }
  })
  await page.goto('/logs')
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Logs are temporarily unavailable.',
  )
  fail = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(
    logEntries(page).filter({ hasText: 'Retry Test Knife' }).first(),
  ).toBeVisible()
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
  await page.unroute('**/api/logs')
  await page.route('**/api/logs', (route) =>
    route.fulfill({ json: { events: [] } }),
  )
  await page.reload()
  await expect(
    page.getByText('No log entries yet', { exact: true }),
  ).toBeVisible()
  await expect(logEntries(page)).toHaveCount(0)
  await expect(
    page.getByRole('complementary', { name: /Event details for/ }),
  ).toHaveCount(0)
})
