import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { clearStorageCache } from '@/lib/storage'
import { closeLocalDb } from '@/lib/local-db'

export type TempVault = {
  dataDir: string
  cleanup: () => Promise<void>
}

export async function createTempVault(
  prefix = 'bladevault-test-',
): Promise<TempVault> {
  closeLocalDb()
  clearStorageCache()

  const previousDataDir = process.env.BLADEVAULT_DATA_DIR
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  process.env.BLADEVAULT_DATA_DIR = dataDir

  return {
    dataDir,
    cleanup: async () => {
      closeLocalDb()
      clearStorageCache()

      if (previousDataDir === undefined) {
        delete process.env.BLADEVAULT_DATA_DIR
      } else {
        process.env.BLADEVAULT_DATA_DIR = previousDataDir
      }

      await fs.rm(dataDir, { recursive: true, force: true })
    },
  }
}
