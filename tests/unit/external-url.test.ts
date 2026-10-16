import { describe, expect, it } from 'vitest'
import {
  escapeHtmlAttribute,
  getSafeExternalUrl,
  normalizeSourceUrl,
} from '@/lib/external-url'

describe('external URL helpers', () => {
  it('normalizes source URLs without conflating product variants or case-sensitive paths', () => {
    expect(
      normalizeSourceUrl(' HTTPS://SHOP.EXAMPLE:443/knife/?b=2&a=1#specs '),
    ).toBe(normalizeSourceUrl('https://shop.example/knife?a=1&b=2'))
    expect(normalizeSourceUrl('https://shop.example/Knife')).not.toBe(
      normalizeSourceUrl('https://shop.example/knife'),
    )
    expect(
      normalizeSourceUrl('https://shop.example/knife?variant=Black'),
    ).not.toBe(normalizeSourceUrl('https://shop.example/knife?variant=black'))
    expect(normalizeSourceUrl('http://shop.example/knife')).not.toBe(
      normalizeSourceUrl('https://shop.example/knife'),
    )
    for (const value of [
      '',
      undefined,
      null,
      'not a URL',
      'javascript:alert(1)',
    ]) {
      expect(normalizeSourceUrl(value)).toBeNull()
    }
  })

  it('allows only HTTP and HTTPS links', () => {
    expect(getSafeExternalUrl('https://example.com/knife')).toBe(
      'https://example.com/knife',
    )
    expect(getSafeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(getSafeExternalUrl('data:text/html,unsafe')).toBeNull()
    expect(getSafeExternalUrl('not a url')).toBeNull()
  })

  it('escapes every HTML attribute delimiter', () => {
    expect(escapeHtmlAttribute(`&\"'<>`)).toBe('&amp;&quot;&#39;&lt;&gt;')
  })
})
