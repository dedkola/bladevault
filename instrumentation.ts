import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/sentry/server-init')
  }
}

export const onRequestError = Sentry.captureRequestError
