'use client'

import NextImage from 'next/image'
import { forwardRef, useSyncExternalStore, type ComponentProps } from 'react'
import {
  getVaultClientState,
  INITIAL_VAULT_CLIENT_STATE,
  subscribeVaultClientState,
} from '@/lib/vault-client-state'

const VaultImage = forwardRef<
  HTMLImageElement,
  Omit<ComponentProps<typeof NextImage>, 'ref'>
>(function VaultImage({ src, unoptimized, ...props }, ref) {
  const { appLockEnabled } = useSyncExternalStore(
    subscribeVaultClientState,
    getVaultClientState,
    () => INITIAL_VAULT_CLIENT_STATE,
  )
  const authenticatedImage =
    appLockEnabled === true &&
    typeof src === 'string' &&
    src.startsWith('/api/images/')

  return (
    <NextImage
      {...props}
      ref={ref}
      src={src}
      unoptimized={authenticatedImage ? true : unoptimized}
    />
  )
})

export default VaultImage
