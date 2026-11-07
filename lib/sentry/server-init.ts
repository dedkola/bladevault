import os from 'node:os'
import * as Sentry from '@sentry/nextjs'
import {
  getErrorReportingConfig,
  isErrorReportingAllowed,
} from '@/lib/sentry/server'
import {
  DATA_COLLECTION,
  scrubBreadcrumb,
  scrubEvent,
} from '@/lib/sentry/shared'

const config = getErrorReportingConfig()

if (config) {
  const homeDir = os.homedir()

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    dataCollection: DATA_COLLECTION,
    // Errors only for now; tracing stays off until it is sampled deliberately.
    tracesSampleRate: 0,
    initialScope: {
      tags: { runtime: config.runtime, arch: process.arch },
    },
    // Without consent nothing leaves the server, not even dropped-event counts.
    sendClientReports: false,
    beforeSend: (event) =>
      isErrorReportingAllowed() ? scrubEvent(event, homeDir) : null,
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb, homeDir),
    beforeSendMetric: (metric) => (isErrorReportingAllowed() ? metric : null),
    beforeSendLog: (log) => (isErrorReportingAllowed() ? log : null),
  })
}
