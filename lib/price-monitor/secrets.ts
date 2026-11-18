import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getLocalDataDirPath } from '@/lib/local-db'
import { rememberSecret } from '@/lib/price-monitor/secret-registry'
import { getVaultControlDir } from '@/lib/vault-access'

/**
 * The price AI key. It lives in a 0600 file in the vault's private control
 * folder, like the Google Drive sign-in, so it is never part of a backup.
 * BLADEVAULT_PRICE_AI_API_KEY overrides the file (Docker, Helm). Nothing
 * returns the key to the browser: only whether one is set and its last four
 * characters.
 */
export const PRICE_AI_KEY_ENV = 'BLADEVAULT_PRICE_AI_API_KEY'
const KEY_FILE = 'price-ai-credentials.json'
export const MAX_PRICE_AI_KEY_LENGTH = 4096

export type PriceAiKeyStatus = {
  hasKey: boolean
  /** Last four characters, or '' when the key is too short to hint at. */
  last4: string
  /** 'env' cannot be replaced or removed from the app. */
  source: 'env' | 'file' | null
}

export class PriceAiKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PriceAiKeyError'
  }
}

export function priceAiKeyPath(dataDir = getLocalDataDirPath()): string {
  return path.join(getVaultControlDir(dataDir), KEY_FILE)
}

function envKey(): string | null {
  const value = process.env[PRICE_AI_KEY_ENV]?.trim()
  return value ? value : null
}

/** Trims and checks a key typed by the user; throws a readable error. */
export function validatePriceAiKey(value: unknown): string {
  if (typeof value !== 'string') throw new PriceAiKeyError('Enter an API key.')
  const key = value.trim()
  if (!key) throw new PriceAiKeyError('Enter an API key.')
  if (key.length > MAX_PRICE_AI_KEY_LENGTH)
    throw new PriceAiKeyError('This API key is too long.')
  // Header values cannot hold spaces or control characters.
  if (!/^[\x21-\x7e]+$/.test(key))
    throw new PriceAiKeyError(
      'An API key cannot contain spaces or special characters.',
    )
  return key
}

async function readKeyFile(dataDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(priceAiKeyPath(dataDir), 'utf8'),
    ) as { apiKey?: unknown }
    return typeof parsed.apiKey === 'string' && parsed.apiKey
      ? parsed.apiKey
      : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

/** The key for server-side requests only; never send it to the browser. */
export async function readPriceAiKey(
  dataDir = getLocalDataDirPath(),
): Promise<string | null> {
  const key = envKey() ?? (await readKeyFile(dataDir))
  rememberSecret(key)
  return key
}

function statusFor(key: string | null, source: PriceAiKeyStatus['source']) {
  return {
    hasKey: Boolean(key),
    last4: key && key.length >= 12 ? key.slice(-4) : '',
    source: key ? source : null,
  } satisfies PriceAiKeyStatus
}

export async function getPriceAiKeyStatus(
  dataDir = getLocalDataDirPath(),
): Promise<PriceAiKeyStatus> {
  const env = envKey()
  if (env) {
    rememberSecret(env)
    return statusFor(env, 'env')
  }
  const key = await readKeyFile(dataDir)
  rememberSecret(key)
  return statusFor(key, 'file')
}

/** Saves the key atomically with owner-only permissions. */
export async function writePriceAiKey(
  value: unknown,
  dataDir = getLocalDataDirPath(),
): Promise<PriceAiKeyStatus> {
  const key = validatePriceAiKey(value)
  const filePath = priceAiKeyPath(dataDir)
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(
      temporaryPath,
      JSON.stringify({ apiKey: key, savedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
  rememberSecret(key)
  return getPriceAiKeyStatus(dataDir)
}

export async function clearPriceAiKey(
  dataDir = getLocalDataDirPath(),
): Promise<PriceAiKeyStatus> {
  await fs.rm(priceAiKeyPath(dataDir), { force: true })
  return getPriceAiKeyStatus(dataDir)
}
