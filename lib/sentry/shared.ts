import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs'

// Client-safe Sentry helpers shared by the server and browser SDK setup.
// Error reporting is off unless the server has a DSN (see lib/sentry/server.ts).

export const ERROR_REPORTING_ATTRIBUTE = 'data-error-reporting'

export const ERROR_REPORTING_RUNTIMES = ['docker', 'desktop', 'server'] as const
export type ErrorReportingRuntime = (typeof ERROR_REPORTING_RUNTIMES)[number]

export type ErrorReportingConfig = {
  dsn: string
  environment: string
  runtime: ErrorReportingRuntime
}

// Sentry v11 collects headers, cookies, bodies, query strings, and stack frame
// variables by default. A knife vault keeps all of that local.
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
}

const REDACTED = '[redacted]'
const MAX_SCRUB_DEPTH = 6

// Values that must never leave the vault: auth tokens, JWTs from the cloud
// backup popup, MCP bearer tokens, and email addresses.
const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[\w.~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, REDACTED],
  [
    /\b(access_?token|session_?token|token|password|secret|api_?key|code|sentry_key)=([^&\s"'#]+)/gi,
    `$1=${REDACTED}`,
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
]

// Browser noise that does not point to a BladeVault defect.
export const IGNORED_CLIENT_ERRORS: Array<string | RegExp> = [
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications',
  'AbortError',
  /^Failed to fetch$/,
  /^NetworkError when attempting to fetch resource\.?$/,
  /^Load failed$/,
  /^The operation was aborted\.?$/,
]

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function homeDirPatterns(homeDir?: string): RegExp[] {
  const trimmed = homeDir?.trim().replace(/[\\/]+$/, '')
  if (!trimmed || trimmed.length < 2) return []

  const variants = new Set([trimmed, trimmed.replace(/\\/g, '/')])
  return [...variants].map((variant) => new RegExp(escapeRegExp(variant), 'gi'))
}

export function scrubText(value: string, homeDir?: string): string {
  let result = value
  for (const pattern of homeDirPatterns(homeDir)) {
    result = result.replace(pattern, '~')
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export function stripUrlQuery(url: string): string {
  const end = url.search(/[?#]/)
  return end === -1 ? url : url.slice(0, end)
}

function scrubValue(
  value: unknown,
  homeDir: string | undefined,
  depth = 0,
): unknown {
  if (typeof value === 'string') return scrubText(value, homeDir)
  if (!value || typeof value !== 'object') return value
  if (depth >= MAX_SCRUB_DEPTH) return REDACTED

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, homeDir, depth + 1))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      scrubValue(entry, homeDir, depth + 1),
    ]),
  )
}

export function scrubBreadcrumb(
  breadcrumb: Breadcrumb,
  homeDir?: string,
): Breadcrumb | null {
  const next: Breadcrumb = { ...breadcrumb }

  if (next.message) next.message = scrubText(next.message, homeDir)

  if (next.data) {
    // Keep only the request shape; drop payloads and arbitrary console args.
    const { method, status_code, url } = next.data as Record<string, unknown>
    const data: Record<string, unknown> = {}
    if (typeof method === 'string') data.method = method
    if (typeof status_code === 'number') data.status_code = status_code
    if (typeof url === 'string')
      data.url = scrubText(stripUrlQuery(url), homeDir)
    next.data = data
  }

  return next
}

export function scrubEvent(event: ErrorEvent, homeDir?: string): ErrorEvent {
  delete event.user
  delete event.server_name

  if (event.request) {
    const { method, url } = event.request
    event.request = {
      ...(method ? { method } : {}),
      ...(url ? { url: scrubText(stripUrlQuery(url), homeDir) } : {}),
    }
  }

  if (event.message) event.message = scrubText(event.message, homeDir)

  if (event.logentry?.message) {
    event.logentry = { message: scrubText(event.logentry.message, homeDir) }
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value, homeDir)
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars
      if (frame.filename) frame.filename = scrubText(frame.filename, homeDir)
      if (frame.abs_path) frame.abs_path = scrubText(frame.abs_path, homeDir)
    }
  }

  if (event.extra) {
    event.extra = scrubValue(event.extra, homeDir) as ErrorEvent['extra']
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map((breadcrumb) => scrubBreadcrumb(breadcrumb, homeDir))
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null)
  }

  return event
}

export function parseErrorReportingConfig(
  value: string | null | undefined,
): ErrorReportingConfig | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as Partial<ErrorReportingConfig>
    if (
      typeof parsed.dsn !== 'string' ||
      !parsed.dsn.startsWith('https://') ||
      typeof parsed.environment !== 'string' ||
      !ERROR_REPORTING_RUNTIMES.includes(
        parsed.runtime as ErrorReportingRuntime,
      )
    ) {
      return null
    }

    return {
      dsn: parsed.dsn,
      environment: parsed.environment,
      runtime: parsed.runtime as ErrorReportingRuntime,
    }
  } catch {
    return null
  }
}
