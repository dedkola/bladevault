const fs = require('fs')
const path = require('path')

// Desktop error reporting is opt-in. The choice lives in the user-data folder
// (not the vault), and the DSNs exist only in release builds, where
// electron-builder writes them into the packaged package.json.

const CONSENT_FILE = 'error-reporting.json'
// 1: crash and error reports (2.2.0). 2: adds anonymous usage data. A "yes"
// to an older version is asked again, about the new part only, and the person
// can keep crash reports without usage data.
const CONSENT_VERSION = 2
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

// askedVersion is the app version the user last answered for. A "no" is
// asked again after the next update; a "yes" is never asked again.
// usageMetrics is false for "crash reports only". Records written before it
// existed count a current-wording "yes" as agreeing to both.
function readConsentRecord(userDataDir) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getConsentPath(userDataDir), 'utf8'),
    )
    const enabled = parsed.enabled === true
    const consentVersion = Number.isInteger(parsed.consentVersion)
      ? parsed.consentVersion
      : 1
    return {
      enabled,
      usageMetrics:
        enabled &&
        consentVersion >= CONSENT_VERSION &&
        parsed.usageMetrics !== false,
      askedVersion:
        typeof parsed.askedVersion === 'string' ? parsed.askedVersion : null,
      consentVersion,
    }
  } catch {
    return {
      enabled: false,
      usageMetrics: false,
      askedVersion: null,
      consentVersion: 0,
    }
  }
}

function readConsent(userDataDir) {
  return readConsentRecord(userDataDir).enabled
}

// usageMetrics defaults to the main choice; pass false for crash reports only.
function writeConsent(userDataDir, enabled, askedVersion, options = {}) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const target = getConsentPath(userDataDir)
  const temp = `${target}.${process.pid}.tmp`
  const payload = {
    enabled: enabled === true,
    usageMetrics: enabled === true && options.usageMetrics !== false,
    askedVersion: typeof askedVersion === 'string' ? askedVersion : null,
    consentVersion: CONSENT_VERSION,
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
  const record = readConsentRecord(userDataDir)
  const enabled = available && record.enabled
  return {
    available,
    enabled,
    // Usage data needs a "yes" given with the current wording.
    usageMetrics: enabled && record.usageMetrics,
    desktopDsn,
    appDsn,
  }
}

// An earlier "yes" given before usage data existed gets the shorter
// "what's new" prompt instead of the first-launch one.
function isUsageDataUpgrade(record) {
  return record.enabled && record.consentVersion < CONSENT_VERSION
}

function shouldAskForConsent(state, record, appVersion) {
  if (!state.available) return false
  if (record.enabled) return record.consentVersion < CONSENT_VERSION
  return record.askedVersion !== appVersion
}

// The embedded Next.js server reads SENTRY_DSN; an empty value keeps it off.
function getEmbeddedServerEnv(state) {
  if (!state.enabled) return { SENTRY_DSN: '', BLADEVAULT_USAGE_METRICS: '' }
  return {
    SENTRY_DSN: state.appDsn,
    SENTRY_ENVIRONMENT: 'production',
    BLADEVAULT_USAGE_METRICS: state.usageMetrics ? '1' : '',
  }
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
  CONSENT_VERSION,
  EXCLUDED_INTEGRATIONS,
  getEmbeddedServerEnv,
  getErrorReportingState,
  getSentryOptions,
  isUsageDataUpgrade,
  readBuildDsns,
  readConsent,
  readConsentRecord,
  scrubBreadcrumb,
  shouldAskForConsent,
  scrubEvent,
  scrubText,
  writeConsent,
}
