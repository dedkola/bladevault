import { getLocalDb } from '@/lib/local-db'
import { withVaultWriteSync } from '@/lib/vault-access'
import { setErrorReportingConsentGranted } from '@/lib/sentry/consent-state'

// The answer to "Help improve BladeVault?" for servers running the official
// image. It lives in the vault's settings table, so it applies to everyone
// using this vault and travels with its backups.

export const ERROR_REPORTING_CONSENT_KEY = 'error_reporting_consent'
export const ERROR_REPORTING_CONSENTS = [
  'unset',
  'granted',
  'declined',
] as const
export type ErrorReportingConsent = (typeof ERROR_REPORTING_CONSENTS)[number]

export function getErrorReportingConsent(): ErrorReportingConsent {
  const row = getLocalDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(ERROR_REPORTING_CONSENT_KEY) as { value?: string } | undefined
  const value =
    row?.value === 'granted' || row?.value === 'declined' ? row.value : 'unset'
  setErrorReportingConsentGranted(value === 'granted')
  return value
}

export function setErrorReportingConsent(
  value: Exclude<ErrorReportingConsent, 'unset'>,
): ErrorReportingConsent {
  return withVaultWriteSync(() => {
    getLocalDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(ERROR_REPORTING_CONSENT_KEY, value)
    setErrorReportingConsentGranted(value === 'granted')
    return value
  })
}
