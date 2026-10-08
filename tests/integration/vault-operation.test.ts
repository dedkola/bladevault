import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as archiveRoute from '@/app/api/cloud-backup/archive/route'
import * as jobRoute from '@/app/api/cloud-backup/job/route'
import * as localBackupRoute from '@/app/api/local-backup/archive/route'
import { getConfiguredCloudBackupUrl } from '@/lib/cloud-backup-server'
import {
  tryBeginVaultOperation,
  withVaultOperation,
} from '@/lib/vault-operation'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const busyMessage =
  'Another backup or restore is running. Try again when it finishes.'
let vaults: TempVault[]
let releases: Array<() => void>

function acquireLease() {
  const release = tryBeginVaultOperation()
  expect(release).toEqual(expect.any(Function))
  releases.push(release!)
  return release!
}

async function expectBusy(response: Response) {
  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toEqual({ error: busyMessage })
}

beforeEach(async () => {
  releases = []
  vaults = [await createTempVault('bladevault-operation-')]
})

afterEach(async () => {
  releases.forEach((release) => release())
  for (const vault of vaults.toReversed()) await vault.cleanup()
  vi.unstubAllGlobals()
})

describe('vault operation lease', () => {
  it('allows only one operation per vault and can be reacquired after release', () => {
    const release = acquireLease()
    expect(tryBeginVaultOperation()).toBeNull()

    release()
    acquireLease()
    expect(tryBeginVaultOperation()).toBeNull()
  })

  it('does not release a newer lease when an old release callback is repeated', () => {
    const release = acquireLease()
    release()
    acquireLease()

    release()

    expect(tryBeginVaultOperation()).toBeNull()
  })

  it('holds the lease during an action and releases it after success', async () => {
    const result = await withVaultOperation(async () => {
      expect(tryBeginVaultOperation()).toBeNull()
      return 'finished'
    })

    expect(result).toBe('finished')
    acquireLease()
  })

  it('releases the lease when an action throws', async () => {
    const failure = new Error('Restore failed')

    await expect(
      withVaultOperation(async () => {
        expect(tryBeginVaultOperation()).toBeNull()
        throw failure
      }),
    ).rejects.toBe(failure)

    acquireLease()
  })

  it('rejects an overlapping action without executing it', async () => {
    let complete!: () => void
    const gate = new Promise<void>((resolve) => {
      complete = resolve
    })
    const first = withVaultOperation(async () => {
      await gate
      return 'finished'
    })
    const overlapping = vi.fn(async () => 'unexpected')

    try {
      const response = await withVaultOperation(overlapping)
      expect(response).toBeInstanceOf(Response)
      await expectBusy(response as Response)
      expect(overlapping).not.toHaveBeenCalled()
    } finally {
      complete()
      await first
    }

    acquireLease()
  })

  it('scopes leases and release callbacks to their original data directory', async () => {
    const firstVault = vaults[0]
    const releaseFirst = acquireLease()
    const secondVault = await createTempVault('bladevault-operation-other-')
    vaults.push(secondVault)
    acquireLease()

    releaseFirst()
    expect(tryBeginVaultOperation()).toBeNull()

    process.env.BLADEVAULT_DATA_DIR = firstVault.dataDir
    acquireLease()
    process.env.BLADEVAULT_DATA_DIR = secondVault.dataDir
    expect(tryBeginVaultOperation()).toBeNull()
  })
})

describe('backup and restore route contention', () => {
  beforeEach(() => {
    acquireLease()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('rejects cloud restore before contacting the backup server', async () => {
    const response = await archiveRoute.POST(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backupUrl: getConfiguredCloudBackupUrl(),
          accessToken: 'restore-token',
        }),
      }),
    )

    await expectBusy(response)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects local ZIP restore before reading the archive', async () => {
    const request = new Request('http://localhost/api/local-backup/archive', {
      method: 'PUT',
      body: 'archive-content',
    })
    const readArchive = vi.spyOn(request, 'arrayBuffer')
    const response = await localBackupRoute.PUT(request)

    await expectBusy(response)
    expect(readArchive).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a new background cloud backup while another vault operation holds the lease', async () => {
    const response = await jobRoute.POST(
      new Request('http://localhost/api/cloud-backup/job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: 'session-token' }),
      }),
    )

    await expectBusy(response)
    expect(fetch).not.toHaveBeenCalled()
  })
})
