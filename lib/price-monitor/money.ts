/**
 * Client-safe money helpers shared by the scraper and price monitoring.
 *
 * Monitoring stores prices as integer minor units plus an ISO 4217 code, so
 * comparisons never suffer float drift. The scraper keeps its display format
 * ("129.00 USD") but parses through the same code.
 */

export type ParsedMoney = {
  /** Amount in major units, e.g. 129.99. Always finite and > 0. */
  amount: number
  /** Currency as found: the hint, a symbol mapping, or a code in the text. */
  currency: string
}

const SYMBOL_CURRENCIES: ReadonlyArray<[string, string]> = [
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
]

// Matches, in order of preference at the same position:
// 1. dot thousands with comma decimals: "1.234,56"
// 2. at least two dot thousand groups: "1.234.567"
// 3. space/comma/apostrophe thousands or plain digits, optional decimals.
const AMOUNT_PATTERN =
  /(?:[$€£¥]\s*)?(\d{1,3}(?:\.\d{3})+,\d{1,2}(?!\d)|\d{1,3}(?:\.\d{3}){2,}(?![\d,.])|(?:\d{1,3}(?:[ ,' ]\d{3})+|\d+)(?:[.,]\d{1,2})?)/

function cleanText(text: string | undefined): string {
  return text?.replace(/\s+/g, ' ').trim() ?? ''
}

function normalizeAmount(raw: string): string {
  const compact = raw.replace(/[ ' ]/g, '')
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(compact)) {
    return compact.replace(/\./g, '').replace(',', '.')
  }
  if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(compact)) {
    return compact.replace(/\./g, '')
  }
  if (compact.includes('.') && compact.includes(',')) {
    return compact.replace(/,/g, '')
  }
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) {
    return compact.replace(/,/g, '')
  }
  return compact.replace(',', '.')
}

/**
 * Parses a price such as "$1,299.00", "1.234,56 €" or "89". A non-empty
 * `currencyHint` wins over symbols and codes found in the text.
 */
export function parseMoneyText(
  value: string | undefined,
  currencyHint = '',
): ParsedMoney | null {
  const cleaned = cleanText(value)
  const match = cleaned.match(AMOUNT_PATTERN)
  if (!match) return null
  const amount = Number(normalizeAmount(match[1]))
  if (!Number.isFinite(amount) || amount <= 0) return null
  const currency =
    cleanText(currencyHint) ||
    SYMBOL_CURRENCIES.find(([symbol]) => cleaned.includes(symbol))?.[1] ||
    cleaned.match(/\b[A-Z]{3}\b/)?.[0] ||
    ''
  return { amount, currency }
}

let supportedCurrencies: ReadonlySet<string> | null | undefined

function getSupportedCurrencies(): ReadonlySet<string> | null {
  if (supportedCurrencies !== undefined) return supportedCurrencies
  try {
    const intl = Intl as typeof Intl & {
      supportedValuesOf?: (key: 'currency') => string[]
    }
    supportedCurrencies = intl.supportedValuesOf
      ? new Set(intl.supportedValuesOf('currency'))
      : null
  } catch {
    supportedCurrencies = null
  }
  return supportedCurrencies
}

/** True for a known ISO 4217 code such as "USD". Case-sensitive. */
export function isIsoCurrencyCode(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return false
  return getSupportedCurrencies()?.has(value) ?? true
}

/** Upper-cases and validates a currency; returns '' when it is not ISO 4217. */
export function normalizeCurrencyCode(value: unknown): string {
  if (typeof value !== 'string') return ''
  const code = value.trim().toUpperCase()
  return isIsoCurrencyCode(code) ? code : ''
}

/** The first valid ISO 4217 code written in the text, e.g. "EUR 89,00". */
export function findCurrencyCodeInText(text: string): string {
  for (const match of text.matchAll(/\b[A-Z]{3}\b/g)) {
    if (isIsoCurrencyCode(match[0])) return match[0]
  }
  return ''
}

/** Decimal places of a currency's minor unit: USD 2, JPY 0, KWD 3. */
export function currencyFractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

/** Converts major units to integer minor units, rounding half up. */
export function toMinorUnits(amount: number, currency: string): number {
  const factor = 10 ** currencyFractionDigits(currency)
  // toFixed absorbs binary float error such as 1.005 * 100 = 100.4999…
  return Math.round(Number((amount * factor).toFixed(6)))
}

export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** currencyFractionDigits(currency)
}

/** Formats minor units for display, e.g. 12999 USD → "$129.99". */
export function formatMoney(
  minor: number,
  currency: string,
  locale?: string,
): string {
  const amount = fromMinorUnits(minor, currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).format(amount)
  } catch {
    const digits = currencyFractionDigits(currency)
    return `${amount.toFixed(digits)} ${currency}`.trim()
  }
}

/**
 * Reads a knife's stored purchase price (`specs.price`, e.g. "129.00 USD").
 * Returns null for an empty or zero price; the currency is '' when unknown.
 */
export function parseStoredPrice(
  value: string | undefined,
): ParsedMoney | null {
  const parsed = parseMoneyText(value)
  if (!parsed) return null
  return {
    amount: parsed.amount,
    currency: normalizeCurrencyCode(parsed.currency),
  }
}
