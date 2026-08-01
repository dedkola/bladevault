const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  shell,
} = require('electron')
const { spawn } = require('child_process')
const { autoUpdater } = require('electron-updater')
const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')
const net = require('net')

const DEV_SERVER_URL = process.env.ELECTRON_START_URL || 'http://127.0.0.1:3000'
const DEV_SERVER_ORIGIN = new URL(DEV_SERVER_URL).origin
const FORCE_PRODUCTION_SERVER = process.env.BLADEVAULT_FORCE_PROD_SERVER === '1'
const SMOKE_TEST_MODE = process.env.BLADEVAULT_SMOKE_TEST === '1'
const SKIP_UPDATE_CHECK = process.env.BLADEVAULT_SKIP_UPDATE_CHECK === '1'
const UPDATE_DEBUG_ENABLED =
  process.platform === 'win32' && process.env.BLADEVAULT_UPDATE_DEBUG !== '0'
const UPDATE_AUTO_TEST = process.env.BLADEVAULT_UPDATE_AUTOTEST === '1'
const UPDATE_AUTO_TEST_INSTALL =
  process.env.BLADEVAULT_UPDATE_AUTOTEST_INSTALL === '1'
const PREFERRED_DESKTOP_PORT = Number.parseInt(
  process.env.BLADEVAULT_DESKTOP_PORT || '3000',
  10,
)
const FALLBACK_CLOUD_AUTH_URL = 'https://auth.bladevault.pro'

function getCloudAuthUrl() {
  const fromEnv = process.env.NEXT_PUBLIC_BLADEVAULT_AUTH_URL?.trim()
  if (fromEnv) {
    let normalized = fromEnv
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`
    }
    return normalized.replace(/\/$/, '')
  }
  return FALLBACK_CLOUD_AUTH_URL
}

let mainWindow = null
let serverProcess = null
let serverOrigin = null
let isQuitting = false
let isInstallingUpdate = false
let updateStatus = { status: 'idle' }
let updateDebugLogPath = null
let windowsUpdaterConfigured = false

function getUpdateDebugLogPath() {
  if (!UPDATE_DEBUG_ENABLED || process.platform !== 'win32') {
    return null
  }

  if (updateDebugLogPath) {
    return updateDebugLogPath
  }

  try {
    const userDataPath = app.getPath('userData')
    fs.mkdirSync(userDataPath, { recursive: true })
    updateDebugLogPath = path.join(userDataPath, 'update-debug.log')
    return updateDebugLogPath
  } catch {
    return null
  }
}

function appendUpdateDebug(message, details) {
  const debugLogPath = getUpdateDebugLogPath()
  if (!debugLogPath) {
    return
  }

  const timestamp = new Date().toISOString()
  const serializedDetails = details ? ` ${JSON.stringify(details)}` : ''
  const line = `[${timestamp}] ${message}${serializedDetails}\n`

  try {
    fs.appendFileSync(debugLogPath, line, 'utf8')
  } catch {
    // Best effort only: update debugging should never break runtime behavior.
  }
}

function publishUpdateStatus(nextStatus) {
  updateStatus = { ...nextStatus, platform: process.platform }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bladevault:update-status', updateStatus)
  }
}

function compareVersions(left, right) {
  const parse = (version) => version.replace(/^v/, '').split('.').map(Number)
  const leftParts = parse(left)
  const rightParts = parse(right)

  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0)
    if (difference !== 0) return difference
  }

  return 0
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'BladeVault desktop updater' } },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume()
          requestJson(response.headers.location).then(resolve, reject)
          return
        }

        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`GitHub returned HTTP ${response.statusCode}.`))
            return
          }

          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('GitHub returned invalid release metadata.'))
          }
        })
      },
    )

    request.setTimeout(15000, () => {
      request.destroy(
        new Error('Timed out requesting GitHub release metadata.'),
      )
    })
    request.on('error', reject)
  })
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    let settled = false
    let finalizeTimer = null

    const clearFinalizeTimer = () => {
      if (finalizeTimer) {
        clearTimeout(finalizeTimer)
        finalizeTimer = null
      }
    }

    const armFinalizeTimer = () => {
      clearFinalizeTimer()
      finalizeTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('Timed out finalizing downloaded update file.'))
        }
      }, 15000)
    }

    const settleResolve = (value) => {
      if (settled) {
        return
      }
      settled = true
      clearFinalizeTimer()
      resolve(value)
    }

    const settleReject = (error) => {
      if (settled) {
        return
      }
      settled = true
      clearFinalizeTimer()
      reject(error)
    }

    const request = https.get(
      url,
      { headers: { 'User-Agent': 'BladeVault desktop updater' } },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume()
          downloadFile(response.headers.location, destination).then(
            resolve,
            reject,
          )
          return
        }

        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`Download failed with HTTP ${response.statusCode}.`))
          return
        }

        const file = fs.createWriteStream(destination)
        const hash = crypto.createHash('sha256')
        let transferred = 0
        let responseEnded = false
        const total = Number(response.headers['content-length'] || 0)

        armFinalizeTimer()

        response.on('data', (chunk) => {
          transferred += chunk.length
          hash.update(chunk)
          armFinalizeTimer()
          publishUpdateStatus({
            status: 'downloading',
            percent: total ? Math.round((transferred / total) * 100) : null,
          })
        })

        response.on('end', () => {
          responseEnded = true
          armFinalizeTimer()
        })

        response.on('aborted', () => {
          settleReject(
            new Error('Update download was aborted by the remote host.'),
          )
        })

        response.on('error', (error) => {
          settleReject(error)
        })

        response.pipe(file)

        file.on('finish', () => {
          armFinalizeTimer()
          file.close()
        })

        file.on('close', () => {
          if (!responseEnded) {
            return
          }

          try {
            settleResolve({ sha256: hash.digest('hex') })
          } catch (error) {
            settleReject(
              error instanceof Error ? error : new Error(String(error)),
            )
          }
        })

        file.on('error', (error) => {
          file.destroy()
          settleReject(error)
        })
      },
    )

    request.setTimeout(30000, () => {
      request.destroy(new Error('Timed out downloading update installer.'))
    })
    request.on('error', (error) => {
      settleReject(error)
    })
  })
}

function getUpdateAssetName() {
  if (process.platform === 'darwin') return 'BladeVault.dmg'
  return null
}

function configureWindowsUpdater() {
  if (process.platform !== 'win32' || windowsUpdaterConfigured) {
    return
  }

  windowsUpdaterConfigured = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableWebInstaller = true
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    debug: (message) =>
      appendUpdateDebug('electron_updater_debug', { message: String(message) }),
    info: (message) =>
      appendUpdateDebug('electron_updater_info', { message: String(message) }),
    warn: (message) =>
      appendUpdateDebug('electron_updater_warn', { message: String(message) }),
    error: (message) =>
      appendUpdateDebug('electron_updater_error', { message: String(message) }),
  }

  autoUpdater.on('checking-for-update', () => {
    appendUpdateDebug('windows_update_checking')
    publishUpdateStatus({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    appendUpdateDebug('windows_update_available', {
      latestVersion: info.version,
    })
    publishUpdateStatus({
      status: 'available',
      version: info.version,
      releaseUrl: `https://github.com/dedkola/bladevault/releases/tag/v${info.version}`,
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    appendUpdateDebug('windows_update_not_available', {
      latestVersion: info.version,
      currentVersion: app.getVersion(),
    })
    publishUpdateStatus({
      status: 'not-available',
      currentVersion: app.getVersion(),
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    publishUpdateStatus({
      status: 'downloading',
      percent: Math.round(progress.percent),
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    appendUpdateDebug('windows_update_downloaded', {
      latestVersion: info.version,
      downloadedFile: info.downloadedFile || null,
    })
    publishUpdateStatus({
      status: 'downloaded',
      version: info.version,
    })
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    appendUpdateDebug('windows_updater_failed', {
      message,
      stack: error instanceof Error ? error.stack : null,
    })
    publishUpdateStatus({ status: 'error', message })
  })
}

async function checkWindowsUpdate() {
  configureWindowsUpdater()

  if (!app.isPackaged) {
    appendUpdateDebug('windows_update_skipped_unpacked_app')
    publishUpdateStatus({
      status: 'not-available',
      currentVersion: app.getVersion(),
    })
    return updateStatus
  }

  await autoUpdater.checkForUpdates()
  return updateStatus
}

async function downloadWindowsUpdate() {
  configureWindowsUpdater()
  publishUpdateStatus({ status: 'downloading', percent: 0 })
  await autoUpdater.downloadUpdate()
  return updateStatus
}

async function checkMacUpdate() {
  appendUpdateDebug('check_mac_update_started', {
    currentVersion: app.getVersion(),
  })

  const release = await requestJson(
    'https://api.github.com/repos/dedkola/bladevault/releases/latest',
  )
  const version = String(release.tag_name || '').replace(/^v/, '')

  appendUpdateDebug('check_mac_update_release', {
    latestVersion: version || null,
    releaseUrl: release.html_url || null,
  })

  const versionComparison = version
    ? compareVersions(version, app.getVersion())
    : 0
  const shouldTreatAsAvailable = Boolean(version) && versionComparison > 0

  if (!shouldTreatAsAvailable) {
    appendUpdateDebug('check_mac_update_not_available', {
      latestVersion: version || null,
      currentVersion: app.getVersion(),
      versionComparison,
    })
    publishUpdateStatus({
      status: 'not-available',
      currentVersion: app.getVersion(),
    })
    return updateStatus
  }

  const assetName = getUpdateAssetName()
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate.name === assetName)
    : null
  if (!asset?.browser_download_url) {
    appendUpdateDebug('check_mac_update_missing_asset', {
      assetName,
      latestVersion: version,
    })
    throw new Error(`The latest release does not contain ${assetName}.`)
  }

  appendUpdateDebug('check_mac_update_available', {
    latestVersion: version,
    downloadUrl: asset.browser_download_url,
    versionComparison,
  })

  publishUpdateStatus({
    status: 'available',
    version,
    releaseUrl: release.html_url,
    downloadUrl: asset.browser_download_url,
  })
  return updateStatus
}

async function downloadMacUpdate() {
  appendUpdateDebug('download_mac_update_started', {
    currentVersion: app.getVersion(),
  })

  const release = await requestJson(
    'https://api.github.com/repos/dedkola/bladevault/releases/latest',
  )
  const version = String(release.tag_name || '').replace(/^v/, '')
  const assetName = getUpdateAssetName()
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate.name === assetName)
    : null
  if (!asset?.browser_download_url || !version) {
    appendUpdateDebug('download_mac_update_missing_asset', {
      assetName,
      latestVersion: version || null,
    })
    throw new Error(`The latest release does not contain ${assetName}.`)
  }

  const destination = path.join(
    os.tmpdir(),
    `BladeVault-${version}-${Date.now()}-${process.pid}.dmg`,
  )
  const result = await downloadFile(asset.browser_download_url, destination)
  const expectedDigest = String(asset.digest || '')
    .replace(/^sha256:/, '')
    .toLowerCase()
  if (expectedDigest && expectedDigest !== result.sha256.toLowerCase()) {
    fs.rmSync(destination, { force: true })
    throw new Error('The downloaded update failed its SHA-256 integrity check.')
  }
  publishUpdateStatus({
    status: 'downloaded',
    version,
    path: destination,
    sha256: result.sha256,
  })

  appendUpdateDebug('download_mac_update_completed', {
    latestVersion: version,
    destination,
    sha256: result.sha256,
  })

  const openError = await shell.openPath(destination)
  if (openError) {
    throw new Error(`Failed to open downloaded update: ${openError}`)
  }
  return updateStatus
}

async function installDownloadedUpdate() {
  appendUpdateDebug('install_downloaded_update_called', {
    pid: process.pid,
    status: updateStatus.status,
  })

  if (isInstallingUpdate) {
    appendUpdateDebug('install_already_in_progress')
    return updateStatus
  }

  if (updateStatus.status !== 'downloaded') {
    appendUpdateDebug('install_aborted_no_downloaded_update')
    throw new Error('No downloaded update is ready to install yet.')
  }

  if (process.platform !== 'win32') {
    appendUpdateDebug('install_aborted_not_win32', {
      platform: process.platform,
    })
    return updateStatus
  }

  isInstallingUpdate = true
  isQuitting = true
  publishUpdateStatus({ status: 'installing' })

  // The embedded Next server runs as a child BladeVault.exe on Windows. Wait
  // for it to release the installation files before starting NSIS.
  appendUpdateDebug('install_stopping_embedded_server')
  await stopEmbeddedServerAndWait()

  // A renderer beforeunload handler can delay app.quit(), allowing NSIS to
  // race the still-running app. The user already chose Install & Restart, so
  // destroy the windows before the updater performs its final app.quit().
  const windows = BrowserWindow.getAllWindows()
  for (const window of windows) {
    window.destroy()
  }
  appendUpdateDebug('install_windows_destroyed', { count: windows.length })

  appendUpdateDebug('calling_electron_updater_quit_and_install')
  autoUpdater.quitAndInstall(true, true)
  return updateStatus
}

async function checkForUpdates() {
  appendUpdateDebug('check_for_updates_called', {
    currentVersion: app.getVersion(),
    platform: process.platform,
  })

  try {
    publishUpdateStatus({ status: 'checking' })
    if (process.platform === 'win32') return checkWindowsUpdate()
    if (process.platform === 'darwin') return checkMacUpdate()
    publishUpdateStatus({
      status: 'not-available',
      currentVersion: app.getVersion(),
    })
    return updateStatus
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendUpdateDebug('check_for_updates_failed', { message })
    publishUpdateStatus({ status: 'error', message })
    return updateStatus
  }
}

async function downloadUpdate() {
  appendUpdateDebug('download_update_called', {
    platform: process.platform,
    status: updateStatus.status,
  })

  try {
    if (process.platform === 'win32') return downloadWindowsUpdate()
    if (process.platform === 'darwin') return downloadMacUpdate()
    return updateStatus
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendUpdateDebug('download_update_failed', { message })
    publishUpdateStatus({ status: 'error', message })
    return updateStatus
  }
}

async function runUpdateAutoTest() {
  appendUpdateDebug('autotest_started', {
    autoInstall: UPDATE_AUTO_TEST_INSTALL,
    currentVersion: app.getVersion(),
  })

  const checked = await checkForUpdates()
  appendUpdateDebug('autotest_after_check', {
    status: checked.status,
  })

  if (checked.status === 'available') {
    const downloaded = await downloadUpdate()
    appendUpdateDebug('autotest_after_download', {
      status: downloaded.status,
      path: downloaded.path || null,
    })
  }

  if (
    UPDATE_AUTO_TEST_INSTALL &&
    process.platform === 'win32' &&
    updateStatus.status === 'downloaded'
  ) {
    appendUpdateDebug('autotest_before_install', {
      status: updateStatus.status,
    })
    await installDownloadedUpdate()
    return
  }

  appendUpdateDebug('autotest_finished', {
    status: updateStatus.status,
  })
}

function isUsingEmbeddedServer() {
  return app.isPackaged || FORCE_PRODUCTION_SERVER
}

function getStandaloneDir() {
  if (app.isPackaged) {
    const unpackedStandaloneDir = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      '.next',
      'standalone',
    )

    if (fs.existsSync(unpackedStandaloneDir)) {
      return unpackedStandaloneDir
    }
  }

  return path.join(app.getAppPath(), '.next', 'standalone')
}

function getServerEntry() {
  return path.join(getStandaloneDir(), 'server.js')
}

function getServerWorkingDir() {
  return getStandaloneDir()
}

function getNodeExecPath() {
  if (app.isPackaged && process.platform === 'darwin') {
    const helperName = `${app.getName()} Helper`
    const helperExecPath = path.join(
      process.resourcesPath,
      '..',
      'Frameworks',
      `${helperName}.app`,
      'Contents',
      'MacOS',
      helperName,
    )

    if (fs.existsSync(helperExecPath)) {
      return helperExecPath
    }
  }

  return process.execPath
}

function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isLocalAppUrl(url) {
  if (!serverOrigin) {
    try {
      return new URL(url).origin === DEV_SERVER_ORIGIN
    } catch {
      return false
    }
  }

  try {
    return new URL(url).origin === serverOrigin
  } catch {
    return false
  }
}

function isAllowedPopupUrl(url) {
  if (url === 'about:blank') {
    return true
  }

  try {
    const parsed = new URL(url)
    const allowedOrigin = new URL(getCloudAuthUrl()).origin
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === allowedOrigin &&
      parsed.pathname.startsWith('/auth/')
    )
  } catch {
    return false
  }
}

function reservePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve a local port.')))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function getPreferredPort() {
  if (Number.isInteger(PREFERRED_DESKTOP_PORT) && PREFERRED_DESKTOP_PORT > 0) {
    try {
      return await reservePort(PREFERRED_DESKTOP_PORT)
    } catch (error) {
      const canFallbackToRandomPort =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'EADDRINUSE' ||
          error.code === 'EACCES' ||
          error.code === 'EPERM')

      appendUpdateDebug('preferred_port_unavailable', {
        preferredPort: PREFERRED_DESKTOP_PORT,
        errorCode:
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : null,
        message: error instanceof Error ? error.message : String(error),
        canFallbackToRandomPort,
      })

      if (!canFallbackToRandomPort) {
        throw error
      }
    }
  }

  return reservePort(0)
}

async function waitForServer(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.ok) {
        return
      }
    } catch {
      // Server is still starting up.
    }

    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(
        `Embedded server exited early with code ${serverProcess.exitCode}.`,
      )
    }

    await delay(400)
  }

  throw new Error(`Timed out waiting for BladeVault to start at ${url}.`)
}

async function startEmbeddedServer() {
  const serverEntry = getServerEntry()
  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `Missing desktop server build at ${serverEntry}. Run "npm run build:desktop" first.`,
    )
  }

  const port = await getPreferredPort()
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BLADEVAULT_DESKTOP_RUNTIME: '1',
    HOSTNAME: '127.0.0.1',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'production',
    PORT: String(port),
  }

  serverProcess = spawn(getNodeExecPath(), [serverEntry], {
    cwd: getServerWorkingDir(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[bladevault-server] ${chunk}`)
  })

  serverProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[bladevault-server] ${chunk}`)
  })

  serverProcess.once('exit', (code) => {
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'BladeVault server stopped',
        `The embedded BladeVault server exited with code ${code ?? 'unknown'}.`,
      )
      mainWindow.close()
    }
  })

  const url = `http://127.0.0.1:${port}`
  await waitForServer(url)
  serverOrigin = new URL(url).origin
  return url
}

function stopEmbeddedServer() {
  if (!serverProcess) {
    return
  }

  serverProcess.kill()
  serverProcess = null
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let timeout = null
    const finish = (didExit) => {
      child.removeListener('exit', handleExit)
      if (timeout) clearTimeout(timeout)
      resolve(didExit)
    }
    const handleExit = () => finish(true)

    child.once('exit', handleExit)
    timeout = setTimeout(() => finish(false), timeoutMs)
  })
}

async function stopEmbeddedServerAndWait(timeoutMs = 5000) {
  const child = serverProcess
  serverProcess = null

  if (!child || child.exitCode !== null) {
    appendUpdateDebug('embedded_server_already_stopped')
    return
  }

  const pid = child.pid ?? null
  const exitPromise = waitForChildExit(child, timeoutMs)
  const killRequested = child.kill()
  const didExit = await exitPromise

  appendUpdateDebug('embedded_server_stop_completed', {
    pid,
    killRequested,
    didExit,
    exitCode: child.exitCode,
  })
}

function getEditableContextMenuTemplate(editFlags) {
  return [
    {
      role: 'undo',
      enabled: editFlags.canUndo,
    },
    {
      role: 'redo',
      enabled: editFlags.canRedo,
    },
    {
      type: 'separator',
    },
    {
      role: 'cut',
      enabled: editFlags.canCut,
    },
    {
      role: 'copy',
      enabled: editFlags.canCopy,
    },
    {
      role: 'paste',
      enabled: editFlags.canPaste,
    },
    {
      role: 'delete',
      enabled: editFlags.canDelete,
    },
    {
      type: 'separator',
    },
    {
      role: 'selectAll',
      enabled: editFlags.canSelectAll,
    },
  ]
}

function buildAppContextMenu(window, params) {
  const hasSelection = params.selectionText.trim().length > 0
  const canCopySelection = params.isEditable
    ? params.editFlags.canCopy
    : hasSelection
  const template = [
    ...getEditableContextMenuTemplate({
      ...params.editFlags,
      canCopy: canCopySelection,
    }),
    {
      type: 'separator',
    },
    {
      label: 'Open Link in Browser',
      enabled: Boolean(params.linkURL),
      click: () => {
        if (!params.linkURL) {
          return
        }

        void shell.openExternal(params.linkURL)
      },
    },
    {
      label: 'Copy Link Address',
      enabled: Boolean(params.linkURL),
      click: () => {
        if (!params.linkURL) {
          return
        }

        clipboard.writeText(params.linkURL)
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Back',
      enabled: window.webContents.canGoBack(),
      click: () => {
        if (!window.webContents.canGoBack()) {
          return
        }

        window.webContents.goBack()
      },
    },
    {
      label: 'Forward',
      enabled: window.webContents.canGoForward(),
      click: () => {
        if (!window.webContents.canGoForward()) {
          return
        }

        window.webContents.goForward()
      },
    },
    {
      label: 'Reload',
      accelerator: 'CmdOrCtrl+R',
      click: () => {
        window.webContents.reload()
      },
    },
  ]

  return Menu.buildFromTemplate(template)
}

function wireAppContextMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    const menu = buildAppContextMenu(window, params)
    menu.popup({
      window,
      x: params.x,
      y: params.y,
      frame: params.frame ?? undefined,
    })
  })
}

function wireMainWindowSecurity(window) {
  window.webContents.on('will-navigate', (event, url) => {
    if (isLocalAppUrl(url)) {
      return
    }

    event.preventDefault()
    void shell.openExternal(url)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedPopupUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          height: 720,
          parent: window,
          title: 'BladeVault Sign In',
          width: 520,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      }
    }

    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

ipcMain.handle('bladevault:select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    buttonLabel: 'Use Folder',
    properties: ['createDirectory', 'openDirectory'],
    title: 'Choose BladeVault Data Folder',
  })

  if (result.canceled) {
    return null
  }

  return result.filePaths[0] ?? null
})

ipcMain.handle('bladevault:get-update-status', () => updateStatus)
ipcMain.handle('bladevault:check-for-updates', () => checkForUpdates())
ipcMain.handle('bladevault:download-update', () => downloadUpdate())
ipcMain.handle('bladevault:install-update', () => installDownloadedUpdate())
async function createMainWindow() {
  const startUrl = isUsingEmbeddedServer()
    ? await startEmbeddedServer()
    : DEV_SERVER_URL

  if (!serverOrigin) {
    serverOrigin = new URL(startUrl).origin
  }

  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#121510',
    height: 960,
    minHeight: 760,
    minWidth: 760,
    show: false,
    title: 'BladeVault',
    width: 1440,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: getPreloadPath(),
      sandbox: true,
    },
  })

  wireMainWindowSecurity(mainWindow)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.webContents.send('bladevault:update-status', updateStatus)
  })

  if (SMOKE_TEST_MODE) {
    const timeout = setTimeout(() => {
      process.exitCode = 1
      app.quit()
    }, 60000)

    mainWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timeout)
      setTimeout(() => app.quit(), 1200)
    })
  }

  await mainWindow.loadURL(startUrl)
}

app.on('before-quit', () => {
  isQuitting = true
  stopEmbeddedServer()
})

app.on('browser-window-created', (_event, window) => {
  wireAppContextMenu(window)
})

app.on('window-all-closed', () => {
  if (isInstallingUpdate) {
    return
  }

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      await createMainWindow()
    } catch (error) {
      dialog.showErrorBox(
        'BladeVault failed to start',
        error instanceof Error ? error.message : 'Unknown error',
      )
      app.quit()
    }
  }
})

app
  .whenReady()
  .then(async () => {
    appendUpdateDebug('app_ready', {
      pid: process.pid,
      version: app.getVersion(),
      updateDebugEnabled: UPDATE_DEBUG_ENABLED,
      startUrl: DEV_SERVER_URL,
      forceProductionServer: FORCE_PRODUCTION_SERVER,
      smokeTestMode: SMOKE_TEST_MODE,
    })

    const runInitialUpdateFlow = () => {
      if (SKIP_UPDATE_CHECK) {
        appendUpdateDebug('initial_update_check_skipped')
        return
      }

      if (UPDATE_AUTO_TEST) {
        void runUpdateAutoTest().catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          appendUpdateDebug('autotest_failed', { message })
          publishUpdateStatus({ status: 'error', message })
        })
        return
      }

      void checkForUpdates().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        appendUpdateDebug('initial_check_for_updates_failed', { message })
        publishUpdateStatus({ status: 'error', message })
      })
    }

    runInitialUpdateFlow()

    try {
      await createMainWindow()
    } catch (error) {
      dialog.showErrorBox(
        'BladeVault failed to start',
        error instanceof Error ? error.message : 'Unknown error',
      )
      app.quit()
    }
  })
  .catch((error) => {
    dialog.showErrorBox(
      'BladeVault failed to start',
      error instanceof Error ? error.message : 'Unknown error',
    )
    app.quit()
  })
