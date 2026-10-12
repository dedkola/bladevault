// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useState, type ComponentProps } from 'react'
import type NextImage from 'next/image'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VaultImage from '@/components/vault-image'
import {
  INITIAL_VAULT_CLIENT_STATE,
  setVaultClientState,
} from '@/lib/vault-client-state'

const { imageProps } = vi.hoisted(() => ({ imageProps: vi.fn() }))
vi.mock('next/image', () => ({
  default: function MockNextImage(props: ComponentProps<typeof NextImage>) {
    const [loads, setLoads] = useState(0)
    imageProps(props)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- NextImage test double.
      <img
        ref={props.ref}
        src={typeof props.src === 'string' ? props.src : '/static.png'}
        alt={props.alt}
        data-unoptimized={String(props.unoptimized)}
        data-loads={loads}
        onLoad={(event) => {
          setLoads((value) => value + 1)
          props.onLoad?.(event)
        }}
      />
    )
  },
}))

const status = {
  generation: 'vault-1',
  phase: 'idle' as const,
  readOnly: false,
  appLockEnabled: false,
}
const localSource = '/api/images/knife/image-01.webp?vault=vault-1'

describe('authenticated vault images', () => {
  beforeEach(() => {
    imageProps.mockClear()
    setVaultClientState(status)
  })
  afterEach(() => {
    cleanup()
    setVaultClientState(INITIAL_VAULT_CLIENT_STATE)
  })

  it('bypasses the optimizer for protected local images while forwarding props and ref', () => {
    setVaultClientState({ ...status, appLockEnabled: true })
    const ref = createRef<HTMLImageElement>()
    const onLoad = vi.fn()
    render(
      <VaultImage
        ref={ref}
        src={localSource}
        alt="Protected knife"
        width={320}
        height={240}
        sizes="50vw"
        loading="eager"
        className="rounded-lg"
        onLoad={onLoad}
        unoptimized={false}
      />,
    )
    const image = screen.getByRole('img', { name: 'Protected knife' })
    expect(image).toHaveAttribute('data-unoptimized', 'true')
    expect(ref.current).toBe(image)
    expect(imageProps.mock.lastCall?.[0]).toMatchObject({
      width: 320,
      height: 240,
      sizes: '50vw',
      loading: 'eager',
      className: 'rounded-lg',
      onLoad,
    })
    fireEvent.load(image)
    expect(onLoad).toHaveBeenCalledOnce()
  })

  it.each([undefined, false, true])(
    'preserves unoptimized=%s for unlocked local images',
    (unoptimized) => {
      render(
        <VaultImage
          src={localSource}
          alt="Unlocked knife"
          width={100}
          height={100}
          unoptimized={unoptimized}
        />,
      )
      expect(imageProps.mock.lastCall?.[0].unoptimized).toBe(unoptimized)
    },
  )

  it.each([
    'https://cdn.example.com/knife.webp',
    'data:image/png;base64,AA==',
    '/icon.svg',
  ])('keeps normal image behavior for %s while App lock is enabled', (src) => {
    setVaultClientState({ ...status, appLockEnabled: true })
    render(
      <VaultImage
        src={src}
        alt="Other image"
        width={100}
        height={100}
        unoptimized={false}
      />,
    )
    expect(imageProps.mock.lastCall?.[0].unoptimized).toBe(false)
  })

  it('preserves static image imports and their explicit optimization setting', () => {
    setVaultClientState({ ...status, appLockEnabled: true })
    const source = { src: '/static-image.png', width: 100, height: 80 }
    render(<VaultImage src={source} alt="Imported image" unoptimized={true} />)
    expect(imageProps.mock.lastCall?.[0]).toMatchObject({
      src: source,
      unoptimized: true,
    })
  })

  it('updates optimization when the lock changes without remounting the image or losing its state', () => {
    render(
      <VaultImage
        src={localSource}
        alt="Knife"
        width={100}
        height={100}
        unoptimized={false}
      />,
    )
    const image = screen.getByRole('img', { name: 'Knife' })
    fireEvent.load(image)
    expect(image).toHaveAttribute('data-loads', '1')
    act(() => setVaultClientState({ ...status, appLockEnabled: true }))
    expect(screen.getByRole('img', { name: 'Knife' })).toBe(image)
    expect(image).toHaveAttribute('data-loads', '1')
    expect(image).toHaveAttribute('data-unoptimized', 'true')
    act(() => setVaultClientState({ ...status, appLockEnabled: false }))
    expect(image).toHaveAttribute('data-unoptimized', 'false')
    expect(image).toHaveAttribute('data-loads', '1')
  })
})
