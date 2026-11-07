const fs = require('fs')
const path = require('path')

// Desktop error reporting is opt-in. The choice lives in the user-data folder
// (not the vault), and the DSNs exist only in release builds, where
// electron-builder writes them into the packaged package.json.

const CONSENT_FILE = 'error-reporting.json'
const REDACTED = '[redacted]'

// The renderer and embedded server already use lib/sentry/shared.ts; this is
// the same filtering for the Electron main process, which cannot load TS.
const TEXT_PATTERNS = [
  [/\bBearer\s+[\w.~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, REDACTED],
  [
    /\b(access_?token|session_?token|token|password|secret|api_?key|code|sentry_key)=([^&\s"'#]+)/gi,
    `$1=${REDACTED}`,
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
]

// Strict data collection: no headers, cookies, bodies, query strings, local
// variables, or user details.
const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
}

// Screenshots and preload injection would reach into the app window; the
// renderer event-loop check needs a renderer SDK that BladeVault does not use.
const EXCLUDED_INTEGRATIONS = new Set([
  'PreloadInjection',
  'Screenshots',
  'RendererEventLoopBlock',
])

function isDsn(value) {
  return typeof value === 'string' && /^https:\/\/\S+$/.test(value.trim())
}

function readBuildDsns(packageJson) {
  const config = packageJson && packageJson.bladevaultErrorReporting
  const desktopDsn = config && config.desktopDsn
  const appDsn = config && config.appDsn
  return {
    desktopDsn: isDsn(desktopDsn) ? desktopDsn.trim() : null,
    appDsn: isDsn(appDsn) ? appDsn.trim() : null,
  }
}

function getConsentPath(userDataDir) {
  return path.join(userDataDir, CONSENT_FILE)
}

function readConsent(userDataDir) {
  try {
    const raw = fs.readFileSync(getConsentPath(userDataDir), 'utf8')
    return JSON.parse(raw).enabled === true
  } catch {
    return false
  }
}

function writeConsent(userDataDir, enabled) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const target = getConsentPath(userDataDir)
  const temp = `${target}.${process.pid}.tmp`
  const payload = {
    enabled: enabled === true,
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`)
  fs.renameSync(temp, target)
  return payload.enabled
}

function getErrorReportingState({
  userDataDir,
  packageJson,
  isPackaged,
  smokeTest,
}) {
  const { desktopDsn, appDsn } = readBuildDsns(packageJson)
  const available = Boolean(isPackaged && !smokeTest && desktopDsn && appDsn)
  return {
    available,
    enabled: available && readConsent(userDataDir),
    desktopDsn,
    appDsn,
  }
}

// The embedded Next.js server reads SENTRY_DSN; an empty value keeps it off.
function getEmbeddedServerEnv(state) {
  if (!state.enabled) return { SENTRY_DSN: '' }
  return { SENTRY_DSN: state.appDsn, SENTRY_ENVIRONMENT: 'production' }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scrubText(value, homeDir) {
  if (typeof value !== 'string') return value
  let result = value
  const home = typeof homeDir === 'string' ? homeDir.replace(/[\\/]+$/, '') : ''
  if (home.length > 1) {
    for (const variant of new Set([home, home.replace(/\\/g, '/')])) {
      result = result.replace(new RegExp(escapeRegExp(variant), 'gi'), '~')
    }
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

function stripUrlQuery(url) {
  const end = url.search(/[?#]/)
  return end === -1 ? url : url.slice(0, end)
}

function scrubBreadcrumb(breadcrumb, homeDir) {
  const next = { ...breadcrumb }
  if (next.message) next.message = scrubText(next.message, homeDir)
  if (next.data) {
    const { method, status_code: statusCode, url } = next.data
    const data = {}
    if (typeof method === 'string') data.method = method
    if (typeof statusCode === 'number') data.status_code = statusCode
    if (typeof url === 'string') {
      data.url = scrubText(stripUrlQuery(url), homeDir)
    }
    next.data = data
  }
  return next
}

function scrubEvent(event, homeDir) {
  delete event.user
  delete event.server_name

  if (event.request) {
    const { method, url } = event.request
    event.request = {}
    if (method) event.request.method = method
    if (url) event.request.url = scrubText(stripUrlQuery(url), homeDir)
  }

  if (event.message) event.message = scrubText(event.message, homeDir)

  const exceptions = (event.exception && event.exception.values) || []
  for (const exception of exceptions) {
    if (exception.value) exception.value = scrubText(exception.value, homeDir)
    const frames = (exception.stacktrace && exception.stacktrace.frames) || []
    for (const frame of frames) {
      delete frame.vars
      if (frame.filename) frame.filename = scrubText(frame.filename, homeDir)
      if (frame.abs_path) frame.abs_path = scrubText(frame.abs_path, homeDir)
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) =>
      scrubBreadcrumb(breadcrumb, homeDir),
    )
  }

  return event
}

function getSentryOptions(state, { release, homeDir }) {
  return {
    dsn: state.desktopDsn,
    release,
    environment: 'production',
    dataCollection: DATA_COLLECTION,
    attachScreenshot: false,
    tracesSampleRate: 0,
    integrations: (defaults) =>
      defaults.filter(
        (integration) => !EXCLUDED_INTEGRATIONS.has(integration.name),
      ),
    initialScope: { tags: { runtime: 'desktop', arch: process.arch } },
    beforeSend: (event) => scrubEvent(event, homeDir),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb, homeDir),
  }
}

module.exports = {
  CONSENT_FILE,
  EXCLUDED_INTEGRATIONS,
  getEmbeddedServerEnv,
  getErrorReportingState,
  getSentryOptions,
  readBuildDsns,
  readConsent,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  writeConsent,
}
