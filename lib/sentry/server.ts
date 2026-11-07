import * as Sentry from '@sentry/nextjs'
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

// Error reporting is opt-in: it runs only when the person operating this
// server sets SENTRY_DSN. Tests, development, and desktop builds leave it unset.
export function getErrorReportingConfig(
  env: Env = process.env,
): ErrorReportingConfig | null {
  const dsn = env.SENTRY_DSN?.trim()
  if (!dsn || !dsn.startsWith('https://')) return null

  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || 'production',
    runtime: getErrorReportingRuntime(env),
  }
}

function isExpectedServerError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

// API routes turn unexpected failures into JSON 500 responses, so Next's
// onRequestError hook never sees them. Call this in those catch blocks.
export function reportServerError(error: unknown, route: string) {
  if (!Sentry.getClient() || isExpectedServerError(error)) return

  Sentry.withScope((scope) => {
    scope.setTag('route', route)
    Sentry.captureException(error)
  })
}
