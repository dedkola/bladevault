import {
  assertVaultGeneration,
  VAULT_GENERATION_HEADER,
  vaultAccessErrorResponse,
  withVaultWrite,
} from '@/lib/vault-access'

// Acquire before reading the body or route params: a delayed request must finish
// against its original vault before restore can install a different generation.
export async function withVaultMutationRequest<T extends Response>(
  request: Request,
  action: () => Promise<T>,
): Promise<T | Response> {
  try {
    return await withVaultWrite(async () => {
      const expected = request.headers.get(VAULT_GENERATION_HEADER)
      if (expected) assertVaultGeneration(expected)
      return action()
    })
  } catch (error) {
    const response = vaultAccessErrorResponse(error)
    if (response) return response
    throw error
  }
}
