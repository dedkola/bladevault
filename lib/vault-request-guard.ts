import { requireAppUnlock } from '@/lib/app-lock'
import {
  assertVaultGeneration,
  getVaultAccessState,
  VAULT_GENERATION_HEADER,
  VaultAccessError,
  vaultAccessErrorResponse,
} from '@/lib/vault-access'

/**
 * Applies the access checks that the Next.js proxy enforces for API requests.
 *
 * The proxy clones every request body it routes and caps that clone at 10 MB by
 * default, silently truncating anything larger. Routes that accept large
 * uploads are excluded from the proxy matcher (`proxy.ts`) and must run these
 * checks themselves before touching the request body.
 */
export function guardUnproxiedVaultRequest(request: Request): Response | null {
  try {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    const state = getVaultAccessState()
    if (state.phase === 'switching')
      throw new VaultAccessError('VAULT_RESTORE_BUSY', state)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const expected = request.headers.get(VAULT_GENERATION_HEADER)
      if (expected) assertVaultGeneration(expected)
      if (state.readOnly)
        throw new VaultAccessError('VAULT_RESTORE_BUSY', state)
    }
  } catch (error) {
    const response = vaultAccessErrorResponse(error)
    if (response) return response
    throw error
  }
  return null
}
