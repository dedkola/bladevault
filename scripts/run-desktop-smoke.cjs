const assert = require('assert/strict')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright')

const projectRoot = process.cwd()
const electronPackageDir = path.dirname(
  require.resolve('electron/package.json'),
)
const electronInstallScript = require.resolve('electron/install.js')
const smokeWorkerFlag = '--smoke-worker'
const smokeWorkerTimeoutMs = 180000

function killProcessTree(child) {
  if (!child.pid || child.exitCode !== null) {
    return
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    return
  }

  const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
    stdio: 'ignore',
  })
  killer.once('error', () => child.kill('SIGKILL'))
  killer.once('exit', (code) => {
    if (code !== 0 && child.exitCode === null) {
      child.kill('SIGKILL')
    }
  })
}

function runSmokeWorker(attempt, attempts) {
  return new Promise((resolve, reject) => {
    console.log(
      `Starting desktop smoke worker (attempt ${attempt}/${attempts})...`,
    )
    const child = spawn(process.execPath, [__filename, smokeWorkerFlag], {
      cwd: projectRoot,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: 'inherit',
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      console.error(
        `Desktop smoke worker timed out after ${smokeWorkerTimeoutMs}ms.`,
      )
      killProcessTree(child)
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL')
          child.unref()
          reject(
            new Error(
              `Desktop smoke worker did not exit after its process tree was terminated.`,
            ),
          )
        }
      }, 10000).unref()
    }, smokeWorkerTimeoutMs)

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (timedOut) {
        reject(
          new Error(
            `Desktop smoke worker was terminated after ${smokeWorkerTimeoutMs}ms.`,
          ),
        )
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Desktop smoke worker exited with ${code ?? signal}.`))
      }
    })
  })
}

async function runSmokeWithRetries() {
  const attempts = process.platform === 'win32' ? 2 : 1
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await runSmokeWorker(attempt, attempts)
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        console.warn(
          `Desktop smoke worker attempt ${attempt} failed; retrying with a fresh process.`,
        )
      }
    }
  }

  throw lastError
}

function installElectronBinary(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [electronInstallScript], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (timedOut) {
        reject(
          new Error(
            `Electron binary installation timed out after ${timeoutMs}ms.`,
          ),
        )
      } else if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `Electron binary installation exited with ${code ?? signal}.`,
          ),
        )
      }
    })
  })
}

async function ensureElectronExecutable() {
  let lastError

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      console.log(`Preparing Electron binary (attempt ${attempt}/2)...`)
      await installElectronBinary()
      const relativeExecutablePath = fs
        .readFileSync(path.join(electronPackageDir, 'path.txt'), 'utf8')
        .trim()
      const executablePath = path.join(
        electronPackageDir,
        'dist',
        relativeExecutablePath,
      )
      if (!fs.existsSync(executablePath)) {
        throw new Error(`Electron executable is missing at ${executablePath}.`)
      }
      console.log('Electron binary is ready.')
      return executablePath
    } catch (error) {
      lastError = error
      if (attempt < 2) {
        console.warn(`Electron binary installation attempt ${attempt} failed.`)
      }
    }
  }

  throw lastError
}

async function main() {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'bladevault-electron-smoke-'),
  )
  const pageErrors = []
  let electronApp = null

  try {
    const executablePath = await ensureElectronExecutable()
    console.log('Launching Electron smoke application...')
    electronApp = await electron.launch({
      args: [
        '.',
        ...(process.platform === 'win32'
          ? ['--disable-gpu', '--disable-software-rasterizer']
          : []),
      ],
      cwd: projectRoot,
      executablePath,
      env: {
        ...process.env,
        BLADEVAULT_DATA_DIR: dataDir,
        BLADEVAULT_DESKTOP_PORT: '0',
        BLADEVAULT_FORCE_PROD_SERVER: '1',
        BLADEVAULT_SKIP_UPDATE_CHECK: '1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      timeout: 120000,
    })

    let window = await electronApp.firstWindow({ timeout: 60000 })
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

    const mcpStatus = await window.evaluate(async () => {
      const response = await fetch('/api/settings/mcp', { cache: 'no-store' })
      return { body: await response.json(), status: response.status }
    })
    assert.equal(mcpStatus.status, 200)
    assert.equal(mcpStatus.body.mcp.stdio.env.BLADEVAULT_DATA_DIR, dataDir)
    assert.equal(mcpStatus.body.mcp.stdio.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(
      mcpStatus.body.mcp.stdio.args[0].endsWith('bladevault-mcp.mjs'),
      true,
    )

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

    const savedComparisons = await window.evaluate(async () => {
      const response = await fetch('/api/comparisons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name: 'Desktop comparison',
          ids: ['electron-smoke'],
        }),
      })
      return { body: await response.json(), status: response.status }
    })
    assert.equal(savedComparisons.status, 200)
    assert.deepEqual(savedComparisons.body.lists[0].ids, ['electron-smoke'])

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

    const restoredOnly = await window.evaluate(async () => {
      const response = await fetch('/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Restored Route Knife',
          brand: 'BladeVault',
        }),
      })
      return { body: await response.json(), status: response.status }
    })
    assert.equal(restoredOnly.status, 200)
    assert.equal(restoredOnly.body.knife.id, 'restored-route-knife')

    const origin = new URL(window.url()).origin
    const archiveResponse = await window
      .context()
      .request.get(`${origin}/api/cloud-backup/archive`)
    assert.equal(archiveResponse.status(), 200)
    const archive = await archiveResponse.body()

    const deleted = await window
      .context()
      .request.delete(`${origin}/api/knives/${restoredOnly.body.knife.id}`)
    assert.equal(deleted.status(), 200)

    await window.goto(`${origin}/collection/${created.body.knife.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await window.getByRole('heading', { name: 'Electron Smoke' }).waitFor()

    const restored = await window
      .context()
      .request.put(`${origin}/api/cloud-backup/archive`, { data: archive })
    assert.equal(restored.status(), 200)

    await window.goto(`${origin}/collection/${restoredOnly.body.knife.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await window
      .getByRole('heading', { name: 'Restored Route Knife' })
      .waitFor()

    if (process.platform === 'darwin') {
      const initialOrigin = new URL(window.url()).origin
      await window.close()
      const reopenedWindow = electronApp.waitForEvent('window')
      await electronApp.evaluate(({ app }) => app.emit('activate'))
      window = await reopenedWindow
      window.on('pageerror', (error) => pageErrors.push(error.message))
      await window.waitForLoadState('domcontentloaded')
      assert.equal(new URL(window.url()).origin, initialOrigin)
    }

    const restoredComparisons = await window.evaluate(async () => {
      const response = await fetch('/api/comparisons', { cache: 'no-store' })
      return response.json()
    })
    assert.deepEqual(
      restoredComparisons.lists.map((list) => ({
        name: list.name,
        ids: list.ids,
      })),
      [{ name: 'Desktop comparison', ids: ['electron-smoke'] }],
    )

    assert.deepEqual(pageErrors, [])

    console.log(
      'Desktop smoke passed: API, named comparisons, native SQLite, restore, reload, and preload boundary.',
    )
  } finally {
    if (electronApp) {
      const electronProcess = electronApp.process()
      await electronApp
        .evaluate(({ app }) => app.emit('before-quit'))
        .catch(() => {})
      if (electronProcess.exitCode === null) {
        const exited = new Promise((resolve) =>
          electronProcess.once('exit', resolve),
        )
        killProcessTree(electronProcess)
        await exited
      }
    }
    fs.rmSync(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    })
  }
}

const run = process.argv.includes(smokeWorkerFlag) ? main : runSmokeWithRetries

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
