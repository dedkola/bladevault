import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('steps through the ledger and acts on the selected knife from the keyboard', async ({
  page,
  request,
}) => {
  await seedKnife(request, {
    name: 'Ledger Alpha',
    brand: 'Acme',
    specs: { bladeMaterial: 'MagnaCut', price: '69.99 USD' },
  })
  await seedKnife(request, {
    name: 'Ledger Bravo',
    brand: 'Zeta',
    specs: { bladeMaterial: 'S30V', lockingMechanism: 'AXIS' },
  })
  // The list columns follow Settings > Card fields, in that order.
  await request.post('/api/settings', {
    data: {
      themeStyle: 'ledger',
      cardFields: ['specs.bladeMaterial', 'specs.price'],
    },
  })

  await page.goto('/collection')
  const title = page.locator('[data-ledger-title]')
  await expect(title).toHaveText('Ledger Alpha')
  await expect(page.locator('[data-ledger-colhead] span')).toHaveText([
    'Name',
    'Steel',
    'Price',
  ])
  // Prices are shortened to fit the column.
  const firstRowCells = page
    .locator('[data-ledger-row]')
    .first()
    .locator('[data-ledger-cell]')
  await expect(firstRowCells).toHaveText(['MagnaCut', '$69.99'])

  // No row is marked until the user picks one; the first J lands on the
  // first entry the detail pane already shows.
  await expect(page.locator('[data-ledger-row][aria-current]')).toHaveCount(0)
  await page.keyboard.press('j')
  await expect(title).toHaveText('Ledger Alpha')
  await expect(page.locator('[data-ledger-row][aria-current]')).toBeFocused()

  // J and K move the selection and keep keyboard focus on the row.
  await page.keyboard.press('j')
  await expect(title).toHaveText('Ledger Bravo')
  await expect(page.locator('[data-ledger-row][aria-current]')).toBeFocused()
  await page.keyboard.press('k')
  await expect(title).toHaveText('Ledger Alpha')
  await expect(page.locator('[data-ledger-row][aria-current]')).toBeFocused()

  // P pins the selected knife.
  const pin = page.locator('[data-ledger-dhead-actions] button').first()
  await page.keyboard.press('p')
  await expect(pin).toHaveAttribute('aria-pressed', 'true')

  // C opens the comparison dialog; keys inside it stay with the dialog.
  await page.keyboard.press('c')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('j')
  await expect(title).toHaveText('Ledger Alpha')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // / and ⌘K focus the filter, which understands field:value words.
  const filter = page.getByRole('searchbox', { name: /Filter knives/ })
  await page.keyboard.press('/')
  await expect(filter).toBeFocused()
  await filter.fill('lock:axis')
  await expect(title).toHaveText('Ledger Bravo')
  await expect(page.locator('[data-ledger-row]')).toHaveCount(1)
  await filter.press('Escape')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(filter).toBeFocused()
  await filter.fill('')
  await filter.press('Escape')

  // E opens the editor for the selected knife; N opens Add.
  await page.keyboard.press('e')
  await expect(page).toHaveURL(/\/collection\/[^/?]+\?edit=1/)
  await page.goto('/collection')
  await expect(title).toBeVisible()
  await page.keyboard.press('n')
  await expect(page).toHaveURL(/\/add$/)
})

test('fits a phone and keeps search, settings and the theme switcher', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Ledger Phone Knife' })
  await request.post('/api/settings', { data: { themeStyle: 'ledger' } })
  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto('/collection')
  const head = page.locator('[data-ledger-head]')
  await expect(
    head.getByRole('button', { name: 'Switch between light and dark' }),
  ).toBeVisible()
  await expect(head.getByRole('link', { name: 'Settings' })).toBeVisible()
  await expect(head.getByRole('link', { name: 'New knife' })).toBeVisible()
  await expect(
    page.locator('[data-workspace-footer] [data-theme-cycle]'),
  ).toBeVisible()

  // Opening a knife shows its document; List returns focus to its row.
  const row = page.locator('[data-ledger-row]').first()
  await row.click()
  const back = page.locator('[data-ledger-back]')
  await expect(back).toBeVisible()
  await back.click()
  await expect(row).toBeFocused()

  for (const path of ['/collection', '/insights', '/compare', '/logs']) {
    await page.goto(path)
    await expect(head).toBeVisible()
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main')
      return {
        page:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        main: main ? main.scrollWidth - main.clientWidth : 0,
      }
    })
    expect(overflow, path).toEqual({ page: 0, main: 0 })
  }

  // The header search folds into an icon and opens within the screen.
  await head.getByRole('button', { name: 'Search knives' }).click()
  const search = page.getByRole('combobox', { name: /Find a knife/ })
  await expect(search).toBeFocused()
  const box = await search.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
})
