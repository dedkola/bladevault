import path from 'path'
import Database from 'better-sqlite3'
import { closeLocalDb, OBSOLETE_SETTINGS_KEYS } from '@/lib/local-db'

/** Values that must never reach a backup once the vault has been opened. */
export const LEGACY_CLOUD_SECRETS = {
  apiToken: 'legacy-cloudflare-api-token-6f1d2c9a',
  previousApiToken: 'legacy-cloudflare-api-token-before-3b7e',
  r2SecretAccessKey: 'legacy-r2-secret-access-key-8c4a0e1f',
} as const

/**
 * Writes the settings rows the removed Cloudflare D1/R2 storage saved, the
 * way old versions did: every key upserted, and the token replaced once so
 * an earlier value sits in the file's free space.
 */
export function seedLegacyCloudSettings(dataDir: string): void {
  closeLocalDb()
  const database = new Database(path.join(dataDir, 'bladevault.sqlite'))
  try {
    database.exec(
      'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    )
    const insert = database.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    )
    const values: Record<(typeof OBSOLETE_SETTINGS_KEYS)[number], string> = {
      storage_mode: 'remote',
      cloudflare_account_id: 'legacy-account-id-0a1b2c3d',
      cloudflare_api_token: LEGACY_CLOUD_SECRETS.previousApiToken,
      d1_database_id: 'legacy-d1-database-id',
      d1_database_name: 'bladevault',
      r2_bucket_name: 'bladevault-images',
      r2_access_key_id: 'legacy-r2-access-key-id',
      r2_secret_access_key: LEGACY_CLOUD_SECRETS.r2SecretAccessKey,
      r2_endpoint: 'https://example.r2.cloudflarestorage.com',
      r2_bucket_url: 'https://images.example.com',
    }
    for (const [key, value] of Object.entries(values)) insert.run(key, value)
    insert.run('cloudflare_api_token', LEGACY_CLOUD_SECRETS.apiToken)
  } finally {
    database.close()
  }
}

export function containsLegacyCloudSecret(bytes: Buffer): boolean {
  return Object.values(LEGACY_CLOUD_SECRETS).some((secret) =>
    bytes.includes(secret),
  )
}
