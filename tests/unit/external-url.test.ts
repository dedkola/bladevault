import { describe, expect, it } from 'vitest'
import { escapeHtmlAttribute, getSafeExternalUrl } from '@/lib/external-url'

describe('external URL helpers', () => {
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
