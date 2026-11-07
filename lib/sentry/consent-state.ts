// In-memory copy of the vault's error reporting answer, so Sentry hooks can
// check it without loading SQLite. lib/error-reporting-consent.ts keeps it
// current; until it has been read, the answer counts as "no".

let granted = false

export function setErrorReportingConsentGranted(value: boolean) {
  granted = value
}

export function isErrorReportingConsentGranted() {
  return granted
}
