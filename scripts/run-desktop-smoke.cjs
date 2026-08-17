const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright')

const projectRoot = process.cwd()

async function main() {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'bladevault-electron-smoke-'),
  )
  const pageErrors = []
  let electronApp = null

  try {
    electronApp = await electron.launch({
      args: ['.'],
      cwd: projectRoot,
      env: {
        ...process.env,
        BLADEVAULT_DATA_DIR: dataDir,
        BLADEVAULT_DESKTOP_PORT: '0',
        BLADEVAULT_FORCE_PROD_SERVER: '1',
        BLADEVAULT_SKIP_UPDATE_CHECK: '1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    })

    const window = await electronApp.firstWindow()
    window.on('pageerror', (error) => pageErrors.push(error.message))
    await window.waitForLoadState('domcontentloaded')
    assert.equal(await window.title(), 'BladeVault | Knife Collection')

    const boundary = await window.evaluate(() => ({
      bridgeKeys: Object.keys(window.bladevaultDesktop ?? {}).sort(),
      hasNodeProcess: typeof window.process !== 'undefined',
      hasRequire: typeof window.require !== 'undefined',
    }))
    assert.deepEqual(boundary.bridgeKeys, [
      'checkForUpdates',
      'downloadUpdate',
      'getUpdateStatus',
      'installUpdate',
      'onUpdateStatus',
      'saveBackupFile',
      'selectDirectory',
    ])
    assert.equal(boundary.hasNodeProcess, false)
    assert.equal(boundary.hasRequire, false)

    const initial = await window.evaluate(async () => {
      const response = await fetch('/api/knives', { cache: 'no-store' })
      return { body: await response.json(), status: response.status }
    })
    assert.equal(initial.status, 200)
    assert.deepEqual(initial.body.knives, [])

    const created = await window.evaluate(async () => {
      const response = await fetch('/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Electron Smoke',
          brand: 'BladeVault',
        }),
      })
      return { body: await response.json(), status: response.status }
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.knife.id, 'electron-smoke')

    await window.reload({ waitUntil: 'domcontentloaded' })
    const persisted = await window.evaluate(async () => {
      const response = await fetch('/api/knives', { cache: 'no-store' })
      return { body: await response.json(), status: response.status }
    })
    assert.equal(persisted.status, 200)
    assert.deepEqual(
      persisted.body.knives.map((knife) => knife.id),
      ['electron-smoke'],
    )
    assert.deepEqual(pageErrors, [])

    console.log(
      'Desktop smoke passed: API, native SQLite, reload, and preload boundary.',
    )
  } finally {
    if (electronApp) await electronApp.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
