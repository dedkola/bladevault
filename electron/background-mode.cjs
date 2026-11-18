const fs = require('fs')
const path = require('path')

// "Keep running in the background" is opt-in. Like the error reporting
// choice, it lives in the user-data folder (not the vault), so the main
// process knows it before the embedded server starts and a restore or a
// different data folder does not change it.

const BACKGROUND_MODE_FILE = 'background-mode.json'

function getBackgroundModePath(userDataDir) {
  return path.join(userDataDir, BACKGROUND_MODE_FILE)
}

// A missing or unreadable file means off.
function readBackgroundMode(userDataDir) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getBackgroundModePath(userDataDir), 'utf8'),
    )
    return parsed !== null && parsed.enabled === true
  } catch {
    return false
  }
}

function writeBackgroundMode(userDataDir, enabled) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const target = getBackgroundModePath(userDataDir)
  const temp = `${target}.${process.pid}.tmp`
  const payload = {
    enabled: enabled === true,
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`)
  fs.renameSync(temp, target)
  return payload.enabled
}

module.exports = {
  BACKGROUND_MODE_FILE,
  readBackgroundMode,
  writeBackgroundMode,
}
