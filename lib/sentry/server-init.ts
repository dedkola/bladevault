import os from 'node:os'
import * as Sentry from '@sentry/nextjs'
import { getErrorReportingConfig } from '@/lib/sentry/server'
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
    beforeSend: (event) => scrubEvent(event, homeDir),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb, homeDir),
  })
}
