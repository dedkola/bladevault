import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeLocalDb } from '@/lib/local-db'
import { GET, POST } from '@/app/api/settings/error-reporting/route'
import {
  getErrorReportingConsent,
  setErrorReportingConsent,
} from '@/lib/error-reporting-consent'
import {
  isErrorReportingConsentGranted,
  setErrorReportingConsentGranted,
} from '@/lib/sentry/consent-state'
import { isErrorReportingAllowed } from '@/lib/sentry/server'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const DEFAULT_DSN = 'https://default@o1.ingest.de.sentry.io/9'
const ENV_KEYS = [
  'BLADEVAULT_DOCKER_RUNTIME',
  'BLADEVAULT_DESKTOP_RUNTIME',
  'BLADEVAULT_DEFAULT_SENTRY_DSN',
  'BLADEVAULT_ERROR_REPORTING',
  'SENTRY_DSN',
] as const

let vault: TempVault | null = null
const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.BLADEVAULT_DOCKER_RUNTIME = '1'
  process.env.BLADEVAULT_DEFAULT_SENTRY_DSN = DEFAULT_DSN
  setErrorReportingConsentGranted(false)
  vault = await createTempVault('bladevault-consent-')
})

afterEach(async () => {
  await vault?.cleanup()
  vault = null
  setErrorReportingConsentGranted(false)
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/settings/error-reporting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function get() {
  return GET(new Request('http://localhost/api/settings/error-reporting'))
}

describe('error reporting consent', () => {
  it('starts unanswered and sends nothing', async () => {
    const response = await get()
    expect(await response.json()).toEqual({
      mode: 'consent',
      consent: 'unset',
      config: null,
    })
    expect(isErrorReportingAllowed()).toBe(false)
  })

  it('turns reporting on after Send Reports and keeps the answer', async () => {
    const response = await post({ consent: 'granted' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      mode: 'consent',
      consent: 'granted',
      config: {
        dsn: DEFAULT_DSN,
        environment: 'production',
        runtime: 'docker',
      },
    })
    expect(isErrorReportingAllowed()).toBe(true)

    // A server restart forgets the cached answer until the vault is read.
    closeLocalDb()
    setErrorReportingConsentGranted(false)
    expect(getErrorReportingConsent()).toBe('granted')
    expect(isErrorReportingConsentGranted()).toBe(true)
  })

  it('stops reporting after Don’t Send', async () => {
    setErrorReportingConsent('granted')
    const response = await post({ consent: 'declined' })
    expect((await response.json()).consent).toBe('declined')
    expect(isErrorReportingAllowed()).toBe(false)
  })

  it('rejects other answers', async () => {
    expect((await post({ consent: 'maybe' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
  })

  it('cannot change an operator-managed DSN', async () => {
    process.env.SENTRY_DSN = 'https://operator@o2.ingest.sentry.io/1'
    expect((await post({ consent: 'declined' })).status).toBe(409)
    const status = await (await get()).json()
    expect(status.mode).toBe('managed')
    expect(status.consent).toBeNull()
  })

  it('cannot be answered when the operator turned reporting off', async () => {
    process.env.BLADEVAULT_ERROR_REPORTING = 'off'
    expect((await post({ consent: 'granted' })).status).toBe(409)
    expect((await (await get()).json()).mode).toBe('off')
  })
})
