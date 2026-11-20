const fs = require('fs')
const path = require('path')

// Native notifications for price drops and restocks while the window is
// hidden, minimized or closed to the tray. Opt-in; like background mode the
// choice lives in the user-data folder (not the vault), so the main process
// knows it without asking the server. The main process polls the embedded
// server with the window's App Lock cookie, so a locked app shows nothing.

const PRICE_NOTIFICATIONS_FILE = 'price-notifications.json'
const PRICE_NOTIFY_POLL_MS = 2 * 60 * 1000
// More new changes than this at once collapse into one summary.
const MAX_SEPARATE_ALERTS = 3

function getPath(userDataDir) {
  return path.join(userDataDir, PRICE_NOTIFICATIONS_FILE)
}

// A missing or unreadable file means off.
function readPriceNotifications(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getPath(userDataDir), 'utf8'))
    return parsed !== null && parsed.enabled === true
  } catch {
    return false
  }
}

function writePriceNotifications(userDataDir, enabled) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const target = getPath(userDataDir)
  const temp = `${target}.${process.pid}.tmp`
  const payload = {
    enabled: enabled === true,
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`)
  fs.renameSync(temp, target)
  return payload.enabled
}

function isAlert(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.knifeId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    typeof value.occurredAt === 'string'
  )
}

/**
 * Turns the server's alerts into what to show: one notification per change,
 * or a single summary that opens the Inbox when there are many. `pathname`
 * is where a click leads: the knife's Market tab, or the Prices inbox.
 */
function planDesktopNotifications(alerts) {
  const list = Array.isArray(alerts) ? alerts.filter(isAlert) : []
  if (list.length > MAX_SEPARATE_ALERTS) {
    const drops = list.filter((alert) => alert.kind === 'drop').length
    const restocks = list.length - drops
    const parts = []
    if (drops) parts.push(`${drops} price ${drops === 1 ? 'drop' : 'drops'}`)
    if (restocks)
      parts.push(`${restocks} ${restocks === 1 ? 'restock' : 'restocks'}`)
    return [
      {
        title: 'BladeVault price changes',
        body: `${parts.join(' and ')}. Open the Inbox to see them.`,
        pathname: '/inbox?filter=prices',
      },
    ]
  }
  return list.map((alert) => ({
    title: alert.title,
    body: alert.body,
    pathname: `/collection/${encodeURIComponent(alert.knifeId)}?tab=market`,
  }))
}

/** The newest occurredAt among the alerts, or `since` when none is newer. */
function nextCursor(since, alerts) {
  let cursor = since
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    if (isAlert(alert) && Date.parse(alert.occurredAt) > Date.parse(cursor)) {
      cursor = alert.occurredAt
    }
  }
  return cursor
}

module.exports = {
  MAX_SEPARATE_ALERTS,
  PRICE_NOTIFICATIONS_FILE,
  PRICE_NOTIFY_POLL_MS,
  nextCursor,
  planDesktopNotifications,
  readPriceNotifications,
  writePriceNotifications,
}
