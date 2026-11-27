import { describe, expect, it } from 'vitest'
import { RETRY_REASONS, retryKey } from '@/lib/price-monitor/rounds'

describe('retry list keys', () => {
  it('names one check per source and one search per knife and store', () => {
    expect(retryKey({ kind: 'check', sourceId: 12 })).toBe('check:12')
    expect(retryKey({ kind: 'search', knifeId: 'k1', store: 'smkw' })).toBe(
      'search:k1:smkw',
    )
  })

  it('keeps the reasons older rows may carry', () => {
    expect(RETRY_REASONS).toContain('store_not_ready')
    expect(RETRY_REASONS).toContain('supervisor')
  })
})
