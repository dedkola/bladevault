const fs = require('fs')
const path = require('path')
const { CONSENT_FILE } = require('./error-reporting.cjs')

// "What's new" after an update. The list is written into the packaged
// package.json at build time (scripts/release-highlights.cjs); the last
// version the user saw lives in the user-data folder, next to the error
// reporting choice.

const STATE_FILE = 'whats-new.json'
// Written by the error reporting prompt since 2.2.0. Its presence on a launch
// with no STATE_FILE means this is an update, not a fresh install.
const EARLIER_INSTALL_MARKER = CONSENT_FILE
const RELEASES_URL = 'https://github.com/dedkola/bladevault/releases/tag'
const MAX_ITEM_LENGTH = 120

function readHighlights(packageJson) {
  const config = packageJson && packageJson.bladevaultWhatsNew
  if (!config || !Array.isArray(config.items)) return null
  const items = config.items
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, MAX_ITEM_LENGTH))
  if (items.length === 0) return null
  const moreCount =
    Number.isInteger(config.moreCount) && config.moreCount > 0
      ? config.moreCount
      : 0
  return { items, moreCount }
}

function readLastSeenVersion(userDataDir) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(userDataDir, STATE_FILE), 'utf8'),
    )
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

function writeLastSeenVersion(userDataDir, version) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const target = path.join(userDataDir, STATE_FILE)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(
    temp,
    `${JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  fs.renameSync(temp, target)
}

// Decides at startup, before any prompt writes to the user-data folder.
// Returns what to show, or null. A fresh install is recorded right away, so
// it never sees notes for the version it was installed with.
function getPendingWhatsNew({
  userDataDir,
  packageJson,
  version,
  isPackaged,
  disabled,
}) {
  if (!isPackaged || disabled) return null
  const lastSeen = readLastSeenVersion(userDataDir)
  if (lastSeen === version) return null
  if (
    lastSeen === null &&
    !fs.existsSync(path.join(userDataDir, EARLIER_INSTALL_MARKER))
  ) {
    try {
      writeLastSeenVersion(userDataDir, version)
    } catch {
      // Not fatal: at worst a fresh install sees the list once.
    }
    return null
  }
  const highlights = readHighlights(packageJson)
  if (!highlights) {
    // Nothing to show for this build; do not ask again for it.
    try {
      writeLastSeenVersion(userDataDir, version)
    } catch {}
    return null
  }
  return { version, ...highlights, url: getReleaseUrl(version) }
}

function getReleaseUrl(version) {
  return `${RELEASES_URL}/v${encodeURIComponent(version)}`
}

function getDialogOptions(pending) {
  const lines = pending.items.map((item) => `• ${item}`)
  if (pending.moreCount > 0) {
    lines.push(
      `• …and ${pending.moreCount} more ${pending.moreCount === 1 ? 'change' : 'changes'}`,
    )
  }
  return {
    type: 'info',
    title: 'BladeVault',
    message: `What’s new in BladeVault ${pending.version}`,
    detail: lines.join('\n'),
    buttons: ['OK', 'See All Changes'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

module.exports = {
  STATE_FILE,
  getDialogOptions,
  getPendingWhatsNew,
  getReleaseUrl,
  readHighlights,
  readLastSeenVersion,
  writeLastSeenVersion,
}
