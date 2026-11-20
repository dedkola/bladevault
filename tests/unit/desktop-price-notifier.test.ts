import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const loadCommonJs = createRequire(import.meta.url)
const notifier = loadCommonJs('../../electron/price-notifier.cjs')

const tempDirs: string[] = []
function makeUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-price-notify-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const alert = (knifeId: string, occurredAt: string, kind = 'drop') => ({
  id: 1,
  knifeId,
  kind,
  title: `Price dropped: ${knifeId}`,
  body: 'example.com · $150.00 → $129.00',
  occurredAt,
})

describe('desktop price notifications', () => {
  it('is off until chosen and remembers the choice', () => {
    const dir = makeUserDataDir()
    expect(notifier.readPriceNotifications(dir)).toBe(false)
    expect(notifier.writePriceNotifications(dir, true)).toBe(true)
    expect(notifier.readPriceNotifications(dir)).toBe(true)
    fs.writeFileSync(path.join(dir, notifier.PRICE_NOTIFICATIONS_FILE), '{')
    expect(notifier.readPriceNotifications(dir)).toBe(false)
  })

  it('opens the knife Market tab for a few changes', () => {
    expect(
      notifier.planDesktopNotifications([
        alert('knife/1', '2026-11-18T12:00:00.000Z'),
      ]),
    ).toEqual([
      {
        title: 'Price dropped: knife/1',
        body: 'example.com · $150.00 → $129.00',
        pathname: '/collection/knife%2F1?tab=market',
      },
    ])
  })

  it('collapses many changes into one Inbox summary and skips bad rows', () => {
    const many = [
      alert('a', '2026-11-18T12:00:00.000Z'),
      alert('b', '2026-11-18T12:01:00.000Z'),
      alert('c', '2026-11-18T12:02:00.000Z', 'back_in_stock'),
      alert('d', '2026-11-18T12:03:00.000Z'),
      { title: 42 },
    ]
    expect(notifier.planDesktopNotifications(many)).toEqual([
      {
        title: 'BladeVault price changes',
        body: '3 price drops and 1 restock. Open the Inbox to see them.',
        pathname: '/inbox?filter=prices',
      },
    ])
    expect(notifier.planDesktopNotifications(null)).toEqual([])
  })

  it('moves the cursor to the newest change only', () => {
    const since = '2026-11-18T12:00:00.000Z'
    expect(notifier.nextCursor(since, [])).toBe(since)
    expect(
      notifier.nextCursor(since, [
        alert('a', '2026-11-18T12:05:00.000Z'),
        alert('b', '2026-11-18T12:02:00.000Z'),
      ]),
    ).toBe('2026-11-18T12:05:00.000Z')
  })
})
