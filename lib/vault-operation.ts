import { getLocalDataDirPath } from '@/lib/local-db'

const VAULT_OPERATIONS = Symbol.for('bladevault.vault-operations')
const BUSY_MESSAGE =
  'Another backup or restore is running. Try again when it finishes.'

export class VaultOperationBusyError extends Error {
  constructor() {
    super(BUSY_MESSAGE)
  }
}

export function tryBeginVaultOperation(): (() => void) | null {
  const runtime = globalThis as typeof globalThis & {
    [VAULT_OPERATIONS]?: Map<string, symbol>
  }
  const operations = (runtime[VAULT_OPERATIONS] ??= new Map())
  const dataDir = getLocalDataDirPath()
  if (operations.has(dataDir)) return null
  const owner = Symbol()
  operations.set(dataDir, owner)
  return () => {
    if (operations.get(dataDir) === owner) operations.delete(dataDir)
  }
}

export async function withVaultOperation<T>(
  action: () => Promise<T>,
): Promise<T | Response> {
  const release = tryBeginVaultOperation()
  if (!release) {
    return Response.json({ error: BUSY_MESSAGE }, { status: 409 })
  }
  try {
    return await action()
  } finally {
    release()
  }
}
