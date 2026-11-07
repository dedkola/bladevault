import * as Sentry from '@sentry/nextjs'
import {
  DATA_COLLECTION,
  IGNORED_CLIENT_ERRORS,
  scrubBreadcrumb,
  scrubEvent,
  type ErrorReportingConfig,
} from '@/lib/sentry/shared'

// Starts or stops the browser SDK. instrumentation-client.ts starts it on
// page load when the server allows reporting; the consent banner and Settings
// start or stop it right after an answer, without a reload.

export function startBrowserErrorReporting(config: ErrorReportingConfig) {
  if (Sentry.getClient()) return
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    dataCollection: DATA_COLLECTION,
    tracesSampleRate: 0,
    ignoreErrors: IGNORED_CLIENT_ERRORS,
    initialScope: { tags: { runtime: config.runtime } },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  })
}

export async function stopBrowserErrorReporting() {
  await Sentry.close()
}
