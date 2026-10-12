export const VAULT_GENERATION_HEADER = 'X-BladeVault-Vault-Generation'
export const VAULT_ACCESS_EVENT = 'bladevault-vault-access-change'

export type VaultAccessPhase = 'idle' | 'preparing' | 'switching'

export type VaultAccessState = {
  generation: string
  phase: VaultAccessPhase
  readOnly: boolean
  recoveryRequired?: boolean
}

export type VaultAccessErrorCode = 'VAULT_RESTORE_BUSY' | 'VAULT_CHANGED'
