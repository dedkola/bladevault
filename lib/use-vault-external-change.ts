'use client'

import { useEffect, useState } from 'react'
import { VAULT_EXTERNAL_CHANGE_EVENT } from '@/lib/vault-client-state'

/**
 * Returns a counter that increases whenever the vault was changed outside this
 * window. Add it to a data-loading effect's dependencies to reload with it.
 */
export function useVaultExternalChangeKey(): number {
  const [key, setKey] = useState(0)
  useEffect(() => {
    const onChange = () => setKey((current) => current + 1)
    window.addEventListener(VAULT_EXTERNAL_CHANGE_EVENT, onChange)
    return () =>
      window.removeEventListener(VAULT_EXTERNAL_CHANGE_EVENT, onChange)
  }, [])
  return key
}
