import { startBrowserErrorReporting } from '@/lib/sentry/client'
import {
  ERROR_REPORTING_ATTRIBUTE,
  parseErrorReportingConfig,
} from '@/lib/sentry/shared'

// The root layout adds the DSN to <html> at request time only when the server
// allows reporting (operator DSN, or a "Send Reports" answer), so the public
// image never starts the browser SDK on its own.
const config = parseErrorReportingConfig(
  document.documentElement.getAttribute(ERROR_REPORTING_ATTRIBUTE),
)

if (config) startBrowserErrorReporting(config)
