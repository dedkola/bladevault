import * as Sentry from '@sentry/nextjs'
import { isErrorReportingConsentGranted } from '@/lib/sentry/consent-state'
import type {
  ErrorReportingConfig,
  ErrorReportingRuntime,
} from '@/lib/sentry/shared'

type Env = Record<string, string | undefined>

export function getErrorReportingRuntime(
  env: Env = process.env,
): ErrorReportingRuntime {
  if (env.BLADEVAULT_DESKTOP_RUNTIME === '1') return 'desktop'
  if (env.BLADEVAULT_DOCKER_RUNTIME === '1') return 'docker'
  return 'server'
}

// How this server decides whether to report:
// - managed: the operator set SENTRY_DSN (or the desktop app did after the
//   user agreed), so reports are sent.
// - consent: the official Docker image carries a default DSN, and reports
//   are sent only after someone answers "Send Reports" in the app.
// - off: no DSN, or the operator set BLADEVAULT_ERROR_REPORTING=off. Tests,
//   development, forks, and local image builds are always off.
export type ErrorReportingMode = 'managed' | 'consent' | 'off'

function readDsn(value: string | undefined) {
  const dsn = value?.trim()
  return dsn && dsn.startsWith('https://') ? dsn : null
}

export function getErrorReportingMode(
  env: Env = process.env,
): ErrorReportingMode {
  if (readDsn(env.SENTRY_DSN)) return 'managed'
  if (
    getErrorReportingRuntime(env) === 'docker' &&
    env.BLADEVAULT_ERROR_REPORTING?.trim().toLowerCase() !== 'off' &&
    readDsn(env.BLADEVAULT_DEFAULT_SENTRY_DSN)
  ) {
    return 'consent'
  }
  return 'off'
}

// The SDK configuration for this server, in either reporting mode. Whether
// anything is actually sent is decided by isErrorReportingAllowed().
export function getErrorReportingConfig(
  env: Env = process.env,
): ErrorReportingConfig | null {
  const mode = getErrorReportingMode(env)
  if (mode === 'off') return null

  const dsn =
    mode === 'managed'
      ? readDsn(env.SENTRY_DSN)
      : readDsn(env.BLADEVAULT_DEFAULT_SENTRY_DSN)
  if (!dsn) return null

  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || 'production',
    runtime: getErrorReportingRuntime(env),
  }
}

export function isErrorReportingAllowed(env: Env = process.env) {
  const mode = getErrorReportingMode(env)
  if (mode === 'managed') return true
  if (mode === 'consent') return isErrorReportingConsentGranted()
  return false
}

function isExpectedServerError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

// API routes turn unexpected failures into JSON 500 responses, so Next's
// onRequestError hook never sees them. Call this in those catch blocks.
export function reportServerError(error: unknown, route: string) {
  if (
    !Sentry.getClient() ||
    !isErrorReportingAllowed() ||
    isExpectedServerError(error)
  )
    return

  Sentry.withScope((scope) => {
    scope.setTag('route', route)
    Sentry.captureException(error)
  })
}
