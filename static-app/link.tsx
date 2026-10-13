'use client'

import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import type { LinkProps } from 'next/link'
import { navigate } from './navigation'

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & LinkProps

export default function Link({
  href,
  replace,
  scroll,
  prefetch: _prefetch,
  onNavigate: _onNavigate,
  ...props
}: Props) {
  const target =
    typeof href === 'string'
      ? href
      : `${href.pathname ?? '/'}${href.search ?? ''}${href.hash ?? ''}`
  function click(event: MouseEvent<HTMLAnchorElement>) {
    props.onClick?.(event)
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      props.target === '_blank' ||
      props.download
    )
      return
    const url = new URL(target, window.location.href)
    if (url.origin !== window.location.origin) return
    event.preventDefault()
    navigate(target, replace, scroll !== false)
  }
  return <a {...props} href={target} onClick={click} />
}
