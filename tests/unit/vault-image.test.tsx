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
    const source = typeof props.src === 'string' ? props.src : '/static.png'
    const optimized =
      !props.unoptimized &&
      source.startsWith('/api/images/') &&
      !source.split('?')[0].endsWith('.svg')
    return (
      // eslint-disable-next-line @next/next/no-img-element -- NextImage test double.
      <img
        ref={props.ref}
        src={
          optimized ? `/_next/image?url=${encodeURIComponent(source)}` : source
        }
        alt={props.alt}
        data-unoptimized={String(props.unoptimized)}
        data-loads={loads}
        onLoad={(event) => {
          setLoads((value) => value + 1)
          props.onLoad?.(event)
        }}
        onError={props.onError}
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

  it('retries a failed local optimization with its original before reporting an error', () => {
    const ref = createRef<HTMLImageElement>()
    const onError = vi.fn()
    const onLoad = vi.fn()
    render(
      <VaultImage
        ref={ref}
        src={localSource}
        alt="Large original"
        width={100}
        height={100}
        onError={onError}
        onLoad={onLoad}
      />,
    )

    const image = screen.getByRole('img', { name: 'Large original' })
    fireEvent.error(image)
    expect(image).toHaveAttribute('data-unoptimized', 'true')
    expect(image).toHaveAttribute('src', localSource)
    expect(ref.current).toBe(image)
    expect(onError).not.toHaveBeenCalled()
    fireEvent.load(image)
    expect(onLoad).toHaveBeenCalledOnce()

    fireEvent.error(image)
    expect(onError).toHaveBeenCalledOnce()
    expect(image).toHaveAttribute('data-unoptimized', 'true')
  })

  it('keeps optimization available when the image source changes', () => {
    const props = { alt: 'Knife', width: 100, height: 100 }
    const { rerender } = render(<VaultImage {...props} src={localSource} />)
    fireEvent.error(screen.getByRole('img', { name: 'Knife' }))
    expect(imageProps.mock.lastCall?.[0].unoptimized).toBe(true)

    rerender(
      <VaultImage
        {...props}
        src="/api/images/knife/image-02.webp?vault=vault-1"
      />,
    )
    expect(imageProps.mock.lastCall?.[0].unoptimized).toBeUndefined()

    rerender(
      <VaultImage
        {...props}
        src="/api/images/knife/image-01.webp?vault=vault-2"
      />,
    )
    expect(imageProps.mock.lastCall?.[0].unoptimized).toBeUndefined()
  })

  it.each([
    { src: localSource, unoptimized: true, appLockEnabled: false },
    { src: localSource, unoptimized: false, appLockEnabled: true },
    {
      src: 'https://cdn.example.com/knife.webp',
      unoptimized: false,
      appLockEnabled: false,
    },
  ])(
    'reports errors without retrying an original or external image (%j)',
    (props) => {
      setVaultClientState({ ...status, appLockEnabled: props.appLockEnabled })
      const onError = vi.fn()
      render(
        <VaultImage
          src={props.src}
          unoptimized={props.unoptimized}
          alt="Failed image"
          width={100}
          height={100}
          onError={onError}
        />,
      )
      const originalOptimization = imageProps.mock.lastCall?.[0].unoptimized

      fireEvent.error(screen.getByRole('img', { name: 'Failed image' }))
      expect(onError).toHaveBeenCalledOnce()
      expect(imageProps.mock.lastCall?.[0].unoptimized).toBe(
        originalOptimization,
      )
    },
  )

  it('reports a local SVG error without retrying its already-original source', () => {
    const onError = vi.fn()
    const src = '/api/images/knife/image-01.svg?vault=vault-1'
    render(
      <VaultImage
        src={src}
        alt="SVG"
        width={100}
        height={100}
        onError={onError}
      />,
    )
    const image = screen.getByRole('img', { name: 'SVG' })
    expect(image).toHaveAttribute('src', src)

    fireEvent.error(image)
    expect(onError).toHaveBeenCalledOnce()
    expect(imageProps.mock.lastCall?.[0].unoptimized).toBeUndefined()
  })

  it('reports an already-original local request error when optimization is disabled elsewhere', () => {
    const onError = vi.fn()
    render(
      <VaultImage
        src={localSource}
        alt="Original"
        width={100}
        height={100}
        onError={onError}
      />,
    )
    const image = screen.getByRole('img', { name: 'Original' })
    image.setAttribute('src', localSource)

    fireEvent.error(image)
    expect(onError).toHaveBeenCalledOnce()
    expect(imageProps.mock.lastCall?.[0].unoptimized).toBeUndefined()
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
