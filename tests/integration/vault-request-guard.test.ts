import { afterEach, describe, expect, it } from 'vitest'
import { getLocalDb } from '@/lib/local-db'
import {
  acquireVaultRestore,
  VAULT_GENERATION_HEADER,
  type VaultRestoreLease,
} from '@/lib/vault-access'
import { guardUnproxiedVaultRequest } from '@/lib/vault-request-guard'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null
let lease: VaultRestoreLease | null = null

afterEach(async () => {
  lease?.release()
  lease = null
  await vault?.cleanup()
  vault = null
})

describe('unproxied vault request guard', () => {
  it('allows reads and writes on an idle vault', async () => {
    vault = await createTempVault('bladevault-guard-')

    expect(
      guardUnproxiedVaultRequest(new Request('http://localhost/api/test')),
    ).toBeNull()
    expect(
      guardUnproxiedVaultRequest(
        new Request('http://localhost/api/test', {
          method: 'POST',
          body: 'archive',
        }),
      ),
    ).toBeNull()
  })

  it('rejects writes while a restore holds the vault but still allows reads', async () => {
    vault = await createTempVault('bladevault-guard-')
    // Keep the vault database warm so the app lock check does not need to open
    // it while the restore marker is installed.
    getLocalDb()
    lease = acquireVaultRestore()

    expect(
      guardUnproxiedVaultRequest(new Request('http://localhost/api/test')),
    ).toBeNull()

    const blocked = guardUnproxiedVaultRequest(
      new Request('http://localhost/api/test', {
        method: 'PUT',
        body: 'archive',
      }),
    )
    expect(blocked?.status).toBe(423)
    await expect(blocked!.json()).resolves.toMatchObject({
      code: 'VAULT_RESTORE_BUSY',
    })
  })

  it('rejects requests that were sent for a previous vault generation', async () => {
    vault = await createTempVault('bladevault-guard-')

    const blocked = guardUnproxiedVaultRequest(
      new Request('http://localhost/api/test', {
        method: 'POST',
        headers: { [VAULT_GENERATION_HEADER]: 'stale-generation' },
        body: 'archive',
      }),
    )

    expect(blocked?.status).toBe(409)
    await expect(blocked!.json()).resolves.toMatchObject({
      code: 'VAULT_CHANGED',
    })
  })
})
