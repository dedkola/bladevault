import type { VaultAccessState } from '@/lib/vault-access-shared'

export type VaultClientState = Omit<VaultAccessState, 'generation'> & {
  generation: string | null
  appLockEnabled?: boolean
}

export const VAULT_CLIENT_STATE_EVENT = 'bladevault-vault-state-change'
export const INITIAL_VAULT_CLIENT_STATE: VaultClientState = {
  generation: null,
  phase: 'idle',
  readOnly: false,
}

let state = INITIAL_VAULT_CLIENT_STATE
const listeners = new Set<() => void>()

export function getVaultClientState(): VaultClientState {
  return typeof window === 'undefined' ? INITIAL_VAULT_CLIENT_STATE : state
}

export function setVaultClientState(next: VaultClientState): void {
  if (typeof window === 'undefined') return
  if (
    state.generation === next.generation &&
    state.phase === next.phase &&
    state.readOnly === next.readOnly &&
    state.recoveryRequired === next.recoveryRequired &&
    state.appLockEnabled === next.appLockEnabled
  ) {
    return
  }
  state = next
  for (const listener of listeners) listener()
  window.dispatchEvent(new Event(VAULT_CLIENT_STATE_EVENT))
}

export function subscribeVaultClientState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
