/**
 * Secret values this process has seen (the price AI key), so error messages
 * and Sentry events can redact them. Dependency-free on purpose: the Sentry
 * setup imports it without loading SQLite or the filesystem helpers.
 */
const REGISTRY = Symbol.for('bladevault.price-monitor.secrets')
const REDACTED = '[redacted]'
/** Short values would redact ordinary words; real keys are much longer. */
const MIN_SECRET_LENGTH = 8

function secrets(): Set<string> {
  const scope = globalThis as typeof globalThis & {
    [REGISTRY]?: Set<string>
  }
  return (scope[REGISTRY] ??= new Set())
}

export function rememberSecret(value: string | null | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) secrets().add(value)
}

/** Replaces every known secret (and any Bearer token) in the text. */
export function redactSecrets(text: string): string {
  let result = text
  for (const secret of secrets()) result = result.split(secret).join(REDACTED)
  return result.replace(/\bBearer\s+[^\s"',]+/gi, `Bearer ${REDACTED}`)
}

/** Redacts known secrets anywhere in a JSON-serializable value. */
export function redactSecretsDeep<T>(value: T): T {
  if (!secrets().size || value === null || value === undefined) return value
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return value
    let redacted = json
    for (const secret of secrets()) {
      // Match the secret as it appears inside a JSON string.
      const encoded = JSON.stringify(secret).slice(1, -1)
      redacted = redacted.split(encoded).join(REDACTED)
    }
    return redacted === json ? value : (JSON.parse(redacted) as T)
  } catch {
    return value
  }
}
