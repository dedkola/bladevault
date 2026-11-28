import { describe, expect, it } from 'vitest'
import {
  buildSourceReview,
  parseReviewDetail,
  reviewKnifeFromRow,
  type ReviewDetail,
} from '@/lib/price-monitor/review'
import { parseVerifyAnswer, reviewDetailOf } from '@/lib/price-monitor/verify'

const FRAGMENT =
  'Title: Raccoon TiSlim Crossbar A4516\n<span class="price-now">$145.99</span>'
const READING = {
  priceMinor: 14599,
  currency: 'USD',
  availability: 'in_stock' as const,
}
const answer = {
  verdict: 'rejected',
  issue: 'wrong_variant',
  pagePrice: null,
  confidence: 0.9,
  reason: 'The page is for the crossbar-lock version.',
  page: {
    title: 'Vosteed Raccoon TiSlim Crossbar A4516',
    modelNumber: { value: 'A4516', match: 'same' },
    lockingMechanism: { value: 'Crossbar lock', match: 'different' },
    bladeCoating: { value: 'Black stonewash', match: 'different' },
    handleMaterial: { value: 'Blue/purple titanium', match: 'same' },
  },
}

describe('page details in AI verdicts', () => {
  it('keeps the page title and each detail with its match', () => {
    const verdict = parseVerifyAnswer(answer, FRAGMENT, READING)
    if (verdict.status !== 'rejected') throw new Error('expected a rejection')
    expect(verdict.title).toBe('Vosteed Raccoon TiSlim Crossbar A4516')
    expect(verdict.page).toEqual({
      modelNumber: { value: 'A4516', match: 'same' },
      lockingMechanism: { value: 'Crossbar lock', match: 'different' },
      bladeCoating: { value: 'Black stonewash', match: 'different' },
      handleMaterial: { value: 'Blue/purple titanium', match: 'same' },
    })
  })

  it('reads a missing or malformed page as unknown, and drops made-up prices', () => {
    const bare = parseVerifyAnswer(
      { ...answer, page: undefined },
      FRAGMENT,
      READING,
    )
    expect(bare).toMatchObject({ status: 'rejected', title: null, page: {} })

    const odd = parseVerifyAnswer(
      {
        ...answer,
        page: {
          title: 'Raccoon, now $99.00',
          modelNumber: { value: 'A4516', match: 'maybe' },
          lockingMechanism: { value: null, match: 'different' },
          bladeCoating: 'Satin',
        },
      },
      FRAGMENT,
      READING,
    )
    if (odd.status !== 'rejected') throw new Error('expected a rejection')
    // $99.00 is not on the page: the title quoting it is dropped.
    expect(odd.title).toBeNull()
    expect(odd.page).toEqual({
      modelNumber: { value: 'A4516', match: 'unknown' },
      lockingMechanism: { value: null, match: 'unknown' },
    })
  })
})

describe('the comparison', () => {
  const knife = reviewKnifeFromRow({
    specs: JSON.stringify({
      modelNumber: 'A4516',
      lockingMechanism: 'Top Liner Lock',
      bladeCoating: 'Satin',
      price: '149.00 USD',
    }),
    handle_material: 'Titanium',
  })

  const product = {
    brand: 'Vosteed',
    name: 'Raccoon TiSlim',
    specs: {
      modelNumber: 'A4516',
      lockingMechanism: 'Top Liner Lock',
      bladeCoating: 'Satin',
      handleMaterial: 'Titanium',
    },
  }

  it('pairs the knife with what AI saw, round-tripped through storage', () => {
    const verdict = parseVerifyAnswer(answer, FRAGMENT, READING)
    if (verdict.status !== 'rejected') throw new Error('expected a rejection')
    const stored = parseReviewDetail(
      JSON.stringify(reviewDetailOf(verdict, product)),
    )
    const review = buildSourceReview(knife, stored)
    expect(review).toMatchObject({
      issue: 'wrong_variant',
      version: true,
      title: 'Vosteed Raccoon TiSlim Crossbar A4516',
    })
    expect(review?.rows).toEqual([
      {
        field: 'modelNumber',
        label: 'Model no.',
        yours: 'A4516',
        page: 'A4516',
        match: 'same',
      },
      {
        field: 'lockingMechanism',
        label: 'Lock',
        yours: 'Top Liner Lock',
        page: 'Crossbar lock',
        match: 'different',
      },
      {
        field: 'bladeCoating',
        label: 'Blade finish',
        yours: 'Satin',
        page: 'Black stonewash',
        match: 'different',
      },
      {
        field: 'handleMaterial',
        label: 'Handle',
        yours: 'Titanium',
        page: 'Blue/purple titanium',
        match: 'same',
      },
    ])
  })

  it('stops trusting AI for a detail the user changed since it checked', () => {
    const verdict = parseVerifyAnswer(answer, FRAGMENT, READING)
    if (verdict.status !== 'rejected') throw new Error('expected a rejection')
    const stored = parseReviewDetail(
      JSON.stringify(reviewDetailOf(verdict, product)),
    )
    const fixed = reviewKnifeFromRow({
      specs: JSON.stringify({
        modelNumber: 'A4516',
        lockingMechanism: 'Crossbar lock',
        bladeCoating: 'Satin',
      }),
      handle_material: 'Titanium',
    })
    const lock = buildSourceReview(fixed, stored)?.rows.find(
      (row) => row.field === 'lockingMechanism',
    )
    expect(lock).toMatchObject({
      yours: 'Crossbar lock',
      page: 'Crossbar lock',
      match: 'unknown',
      changed: true,
    })
  })

  it('never calls a detail different when one side is missing', () => {
    const detail: ReviewDetail = {
      issue: 'different_price',
      pagePrice: '$129.99',
      title: null,
      page: {
        lockingMechanism: { value: null, match: 'different' },
        bladeCoating: { value: 'Satin', match: 'same' },
      },
    }
    const review = buildSourceReview(
      { handleMaterial: '', specs: { lockingMechanism: 'Crossbar' } },
      detail,
    )
    expect(review?.version).toBe(false)
    expect(review?.rows.map((row) => [row.field, row.match])).toEqual([
      ['lockingMechanism', 'unknown'],
      ['bladeCoating', 'unknown'],
    ])
  })

  it('reads broken stored details as none', () => {
    expect(parseReviewDetail(null)).toBeNull()
    expect(parseReviewDetail('{oops')).toBeNull()
    expect(parseReviewDetail('{"page":{}}')).toBeNull()
    expect(buildSourceReview(knife, null)).toBeNull()
  })
})
