import * as Sentry from '@sentry/nextjs'
import {
  DATA_COLLECTION,
  ERROR_REPORTING_ATTRIBUTE,
  IGNORED_CLIENT_ERRORS,
  parseErrorReportingConfig,
  scrubBreadcrumb,
  scrubEvent,
} from '@/lib/sentry/shared'

// The root layout adds the DSN to <html> at request time only when the server
// has error reporting configured, so the public image never embeds a DSN.
const config = parseErrorReportingConfig(
  document.documentElement.getAttribute(ERROR_REPORTING_ATTRIBUTE),
)

if (config) {
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
