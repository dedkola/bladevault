import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'
import { captureAppLockAccessSnapshot } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { acquireVaultRestore, type VaultRestoreLease } from '@/lib/vault-access'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null
let lease: VaultRestoreLease | null = null
afterEach(async () => {
  lease?.release()
  lease = null
  await vault?.cleanup()
  vault = null
})

describe('navigation during the final restore switch', () => {
  it('retries the requested page while API callers receive structured busy status', async () => {
    vault = await createTempVault('bladevault-restore-navigation-')
    getLocalDb()
    captureAppLockAccessSnapshot()
    lease = acquireVaultRestore()
    await lease.beginSwitch()
    const response = proxy(
      new NextRequest('http://localhost/collection/item?sort=name'),
    )!
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    const html = await response.text()
    expect(html).toContain('http-equiv="refresh" content="1"')
    expect(html).toContain('Applying restored vault')
    const api = proxy(new NextRequest('http://localhost/api/knives'))!
    expect(api.status).toBe(503)
    expect(await api.json()).toMatchObject({ code: 'VAULT_RESTORE_BUSY' })
    const status = proxy(new NextRequest('http://localhost/api/vault/status'))!
    expect(status.status).toBe(200)
    lease.finish(false)
    const available = proxy(
      new NextRequest('http://localhost/collection/item?sort=name'),
    )!
    expect(available.status).toBe(200)
  })

  it('gives a recovery action instead of repeatedly refreshing after rollback fails', async () => {
    vault = await createTempVault('bladevault-restore-navigation-recovery-')
    getLocalDb()
    captureAppLockAccessSnapshot()
    lease = acquireVaultRestore()
    await lease.beginSwitch()
    lease.abandon()
    const response = proxy(new NextRequest('http://localhost/collection'))!
    expect(response.status).toBe(503)
    const html = await response.text()
    expect(html).toContain('Restart BladeVault to retry recovery')
    expect(html).not.toContain('http-equiv="refresh"')
  })
})
