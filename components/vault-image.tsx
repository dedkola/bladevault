'use client'

import NextImage from 'next/image'
import {
  forwardRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from 'react'
import {
  getVaultClientState,
  INITIAL_VAULT_CLIENT_STATE,
  subscribeVaultClientState,
} from '@/lib/vault-client-state'

const VaultImage = forwardRef<
  HTMLImageElement,
  Omit<ComponentProps<typeof NextImage>, 'ref'>
>(function VaultImage({ src, unoptimized, onError, ...props }, ref) {
  const [originalSource, setOriginalSource] = useState<string | null>(null)
  const { appLockEnabled } = useSyncExternalStore(
    subscribeVaultClientState,
    getVaultClientState,
    () => INITIAL_VAULT_CLIENT_STATE,
  )
  const localImage = typeof src === 'string' && src.startsWith('/api/images/')
  const useOriginal =
    localImage && (appLockEnabled === true || originalSource === src)
  const imageUnoptimized = useOriginal ? true : unoptimized

  return (
    <NextImage
      {...props}
      ref={ref}
      src={src}
      unoptimized={imageUnoptimized}
      onError={(event) => {
        const failedSource =
          event.currentTarget.currentSrc || event.currentTarget.src
        const optimizerFailed =
          new URL(failedSource, window.location.href).pathname ===
          '/_next/image'
        if (localImage && !imageUnoptimized && optimizerFailed) {
          // Optimizer size/format limits must not hide a saved original. Retry
          // directly before reporting failure to callers that replace the image.
          setOriginalSource(src)
          return
        }
        onError?.(event)
      }}
    />
  )
})

export default VaultImage
