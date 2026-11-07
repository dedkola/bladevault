// BladeVault browser: a plain Electron window for product pages whose bot
// protection rejects the automated (Playwright) browser. Nothing drives the
// page remotely, so verification behaves as it does in a normal browser. When
// the person clicks Continue, the rendered page HTML is handed back to the
// BladeVault window, which imports it through the saved-page API.

const { BaseWindow, WebContentsView, session } = require('electron')
const net = require('net')
const path = require('path')

const PARTITION = 'persist:bladevault-scrape-browser'
const TOOLBAR_HEIGHT = 52
const MAX_HTML_CHARS = 20 * 1024 * 1024
const MAX_IMAGES = 40
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 20000
const IMAGE_CONCURRENCY = 4
const IMAGE_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])
// A separate world keeps page scripts from tampering with the capture.
const CAPTURE_WORLD_ID = 1001

let active = null
let sessionConfigured = false
let lastCapturedUrl = ''

function isPrivateHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  if (net.isIPv6(host)) {
    if (host === '::' || host === '::1') return true
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivateHostname(mapped[1]) : false
  }
  return false
}

/** Public http(s) page or image address, or null. */
function toPublicWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    if (isPrivateHostname(url.hostname)) return null
    return url
  } catch {
    return null
  }
}

function configureSession() {
  const ses = session.fromPartition(PARTITION)
  if (sessionConfigured) return ses
  sessionConfigured = true

  // Keep Electron's own user agent. Claiming to be Chrome makes Cloudflare
  // compare that claim with the browser's real features and repeat its
  // challenge forever.
  ses.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  // Keep pages in this window away from BladeVault's own server and the
  // local network, including subresources and scripted requests.
  ses.webRequest.onBeforeRequest((details, callback) => {
    let cancel = false
    try {
      const url = new URL(details.url)
      if (/^(https?|wss?):$/.test(url.protocol)) {
        cancel = isPrivateHostname(url.hostname)
      }
    } catch {
      cancel = true
    }
    callback({ cancel })
  })
  return ses
}

function sendState() {
  if (!active || active.toolbar.webContents.isDestroyed()) return
  const site = active.site.webContents
  active.toolbar.webContents.send('bladevault:scrape-browser-state', {
    url: site.isDestroyed() ? '' : site.getURL(),
    title: site.isDestroyed() ? '' : site.getTitle(),
    loading: !site.isDestroyed() && site.isLoading(),
    canGoBack: !site.isDestroyed() && site.navigationHistory.canGoBack(),
    canGoForward: !site.isDestroyed() && site.navigationHistory.canGoForward(),
    challenge: active.challenge,
    capturing: active.capturing,
    error: active.error,
  })
}

async function detectChallenge() {
  if (!active || active.site.webContents.isDestroyed()) return
  try {
    const challenge =
      await active.site.webContents.executeJavaScriptInIsolatedWorld(
        CAPTURE_WORLD_ID,
        [
          {
            code: `Boolean(
            /just a moment|attention required|verify you are human|security check/i.test(document.title) ||
            document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, [name="cf-turnstile-response"], #px-captcha, .g-recaptcha')
          )`,
          },
        ],
      )
    if (!active) return
    active.challenge = Boolean(challenge)
    sendState()
  } catch {
    // The page may be navigating; the next load event checks again.
  }
}

function layout() {
  if (!active) return
  const { width, height } = active.window.getContentBounds()
  active.toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT })
  active.site.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width,
    height: Math.max(0, height - TOOLBAR_HEIGHT),
  })
}

function finish(result) {
  const current = active
  if (!current) return
  active = null
  current.resolve(result)
  if (!current.window.isDestroyed()) current.window.destroy()
  const owner = current.getOwner()
  if (owner && !owner.isDestroyed()) owner.focus()
}

async function capture() {
  if (!active || active.capturing) return
  const current = active
  current.capturing = true
  current.error = ''
  sendState()
  try {
    const site = current.site.webContents
    const pageUrl = toPublicWebUrl(site.getURL())
    if (!pageUrl)
      throw new Error('Open a public product page before continuing.')
    const html = await site.executeJavaScriptInIsolatedWorld(CAPTURE_WORLD_ID, [
      {
        code: `(() => {
          const doctype = document.doctype ? '<!DOCTYPE ' + document.doctype.name + '>' : ''
          return doctype + document.documentElement.outerHTML
        })()`,
      },
    ])
    if (typeof html !== 'string' || !html.trim())
      throw new Error('The page has not loaded yet. Try again in a moment.')
    if (html.length > MAX_HTML_CHARS)
      throw new Error('This page is too large to import.')
    if (active !== current) return
    lastCapturedUrl = pageUrl.href
    finish({ status: 'captured', html, url: pageUrl.href })
  } catch (error) {
    if (active !== current) return
    current.capturing = false
    current.error =
      error instanceof Error ? error.message : 'The page could not be read.'
    sendState()
  }
}

function handleToolbarAction(name) {
  if (!active) return
  const site = active.site.webContents
  switch (name) {
    case 'continue':
      void capture()
      break
    case 'cancel':
      finish({ status: 'cancelled' })
      break
    case 'back':
      if (site.navigationHistory.canGoBack()) site.navigationHistory.goBack()
      break
    case 'forward':
      if (site.navigationHistory.canGoForward())
        site.navigationHistory.goForward()
      break
    case 'reload':
      site.reload()
      break
  }
}

function wireSiteContents(contents) {
  const guardNavigation = (event, url) => {
    if (!toPublicWebUrl(url)) event.preventDefault()
  }
  contents.on('will-navigate', guardNavigation)
  contents.on('will-redirect', guardNavigation)
  // Popups (new tabs) open in place so the person stays in one window.
  contents.setWindowOpenHandler(({ url }) => {
    if (toPublicWebUrl(url)) void contents.loadURL(url)
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  for (const eventName of [
    'did-start-loading',
    'did-stop-loading',
    'did-navigate',
    'did-navigate-in-page',
    'page-title-updated',
  ]) {
    contents.on(eventName, () => {
      if (active) active.error = ''
      sendState()
    })
  }
  contents.on('did-stop-loading', () => void detectChallenge())
  contents.on('page-title-updated', () => void detectChallenge())
}

function openScrapeBrowser(rawUrl, getOwner) {
  const url = toPublicWebUrl(rawUrl)
  if (!url) {
    return Promise.reject(
      new Error('Enter a public http or https product URL.'),
    )
  }
  if (active) {
    active.window.focus()
    return Promise.reject(new Error('The BladeVault browser is already open.'))
  }

  const ses = configureSession()
  return new Promise((resolve) => {
    const window = new BaseWindow({
      backgroundColor: '#ffffff',
      height: 900,
      minHeight: 480,
      minWidth: 640,
      title: 'BladeVault Browser',
      width: 1200,
    })
    const toolbar = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'scrape-browser-toolbar-preload.cjs'),
        sandbox: true,
      },
    })
    const site = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: ses,
        webviewTag: false,
      },
    })
    window.contentView.addChildView(toolbar)
    window.contentView.addChildView(site)

    active = {
      window,
      toolbar,
      site,
      resolve,
      getOwner,
      challenge: false,
      capturing: false,
      error: '',
    }

    toolbar.webContents.on('will-navigate', (event) => event.preventDefault())
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    toolbar.webContents.on('did-finish-load', sendState)
    wireSiteContents(site.webContents)

    window.on('resize', layout)
    window.on('closed', () => {
      if (active && active.window === window) {
        const current = active
        active = null
        current.resolve({ status: 'cancelled' })
      }
    })
    layout()

    void toolbar.webContents.loadFile(
      path.join(__dirname, 'scrape-browser-toolbar.html'),
    )
    void site.webContents.loadURL(url.href).catch(() => {
      // Load failures are shown by the page itself; the toolbar stays usable.
    })
    site.webContents.focus()
  })
}

function toImageDataUrl(contentType, buffer) {
  const type = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!IMAGE_TYPES.has(type)) return null
  return `data:${type};base64,${buffer.toString('base64')}`
}

async function fetchImage(ses, url, referer) {
  const response = await ses.fetch(url.href, {
    credentials: 'include',
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  })
  if (!response.ok || !response.body) return null
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES)
    return null
  const chunks = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return toImageDataUrl(
    response.headers.get('content-type'),
    Buffer.concat(chunks),
  )
}

/**
 * Download product images with the BladeVault browser's cookies, so images
 * behind the same bot protection as the page still load. Returns a data URL
 * for each image that downloaded, and null for the rest.
 */
async function fetchScrapeBrowserImages(urls) {
  if (!Array.isArray(urls)) return []
  const list = urls.slice(0, MAX_IMAGES)
  const ses = configureSession()
  const referer = lastCapturedUrl
  const results = new Array(list.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const index = next++
      const url = toPublicWebUrl(list[index])
      if (!url) continue
      try {
        results[index] = await fetchImage(ses, url, referer)
      } catch {
        results[index] = null
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(IMAGE_CONCURRENCY, list.length) }, worker),
  )
  return results
}

function closeScrapeBrowser() {
  finish({ status: 'cancelled' })
}

function registerScrapeBrowser(ipcMain, getOwner) {
  const fromOwner = (event) => {
    const owner = getOwner()
    return Boolean(
      owner && !owner.isDestroyed() && event.sender === owner.webContents,
    )
  }
  const requireOwner = (event) => {
    if (!fromOwner(event)) throw new Error('Not allowed.')
  }

  ipcMain.handle('bladevault:scrape-browser-open', (event, url) => {
    requireOwner(event)
    return openScrapeBrowser(url, getOwner)
  })
  ipcMain.handle('bladevault:scrape-browser-capture', (event) => {
    requireOwner(event)
    return capture()
  })
  ipcMain.handle('bladevault:scrape-browser-cancel', (event) => {
    requireOwner(event)
    closeScrapeBrowser()
  })
  ipcMain.handle('bladevault:scrape-browser-fetch-images', (event, urls) => {
    requireOwner(event)
    return fetchScrapeBrowserImages(urls)
  })
  ipcMain.on('bladevault:scrape-browser-action', (event, name) => {
    if (!active || event.sender !== active.toolbar.webContents) return
    if (typeof name === 'string') handleToolbarAction(name)
  })
}

module.exports = {
  closeScrapeBrowser,
  registerScrapeBrowser,
}
