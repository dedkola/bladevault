import { describe, expect, it } from 'vitest'
import {
  currencyFractionDigits,
  findCurrencyCodeInText,
  formatMoney,
  fromMinorUnits,
  isIsoCurrencyCode,
  normalizeCurrencyCode,
  parseMoneyText,
  parseStoredPrice,
  toMinorUnits,
} from '@/lib/price-monitor/money'

describe('parseMoneyText', () => {
  it.each([
    ['$1,299.00', 1299, 'USD'],
    ['€89,90', 89.9, 'EUR'],
    ['£12', 12, 'GBP'],
    ['¥1500', 1500, 'JPY'],
    ['129.99 CAD', 129.99, 'CAD'],
    ['1 234,50', 1234.5, ''],
    ["1'234.50 CHF", 1234.5, 'CHF'],
    ['1.234,56 €', 1234.56, 'EUR'],
    ['1.234.567', 1234567, ''],
    ['89', 89, ''],
  ])('reads %s', (text, amount, currency) => {
    expect(parseMoneyText(text)).toEqual({ amount, currency })
  })

  it('lets the currency hint win over symbols and codes', () => {
    expect(parseMoneyText('$49.99', 'CAD')).toEqual({
      amount: 49.99,
      currency: 'CAD',
    })
  })

  it('rejects empty, zero and non-numeric values', () => {
    expect(parseMoneyText('')).toBeNull()
    expect(parseMoneyText(undefined)).toBeNull()
    expect(parseMoneyText('0.00 USD')).toBeNull()
    expect(parseMoneyText('Sold out')).toBeNull()
  })
})

describe('currency codes', () => {
  it('accepts only ISO 4217 codes', () => {
    expect(isIsoCurrencyCode('USD')).toBe(true)
    expect(isIsoCurrencyCode('usd')).toBe(false)
    expect(isIsoCurrencyCode('ZZZ')).toBe(false)
    expect(normalizeCurrencyCode(' eur ')).toBe('EUR')
    expect(normalizeCurrencyCode('NEW')).toBe('')
  })

  it('finds the first real code in text', () => {
    expect(findCurrencyCodeInText('NEW price EUR 89,00')).toBe('EUR')
    expect(findCurrencyCodeInText('$89.00')).toBe('')
  })
})

describe('minor units', () => {
  it('uses each currency’s decimal places', () => {
    expect(currencyFractionDigits('USD')).toBe(2)
    expect(currencyFractionDigits('JPY')).toBe(0)
    expect(currencyFractionDigits('KWD')).toBe(3)
  })

  it('converts without float drift', () => {
    expect(toMinorUnits(129.99, 'USD')).toBe(12999)
    expect(toMinorUnits(1.005, 'USD')).toBe(101)
    expect(toMinorUnits(0.1 + 0.2, 'EUR')).toBe(30)
    expect(toMinorUnits(1500, 'JPY')).toBe(1500)
    expect(fromMinorUnits(12999, 'USD')).toBe(129.99)
    expect(fromMinorUnits(1500, 'JPY')).toBe(1500)
  })

  it('formats for display', () => {
    expect(formatMoney(12999, 'USD', 'en-US')).toBe('$129.99')
    expect(formatMoney(1500, 'JPY', 'en-US')).toBe('¥1,500')
  })
})

describe('parseStoredPrice', () => {
  it('reads the stored purchase price format', () => {
    expect(parseStoredPrice('129.00 USD')).toEqual({
      amount: 129,
      currency: 'USD',
    })
    expect(parseStoredPrice('89')).toEqual({ amount: 89, currency: '' })
  })

  it('treats empty, zero and invalid prices as no price', () => {
    expect(parseStoredPrice('')).toBeNull()
    expect(parseStoredPrice(undefined)).toBeNull()
    expect(parseStoredPrice('0')).toBeNull()
    expect(parseStoredPrice('0.00 USD')).toBeNull()
  })

  it('drops a currency that is not ISO 4217', () => {
    expect(parseStoredPrice('50 ABC')).toEqual({ amount: 50, currency: '' })
  })
})
