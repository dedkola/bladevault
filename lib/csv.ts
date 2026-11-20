/**
 * RFC 4180 CSV helpers that are safe to open in a spreadsheet.
 *
 * Text cells that a spreadsheet would read as a formula (starting with
 * `=`, `+`, `-`, `@`, tab or carriage return) get a leading apostrophe, so
 * a store name or URL can never run as a formula. Numbers are written as
 * they are: they are produced by BladeVault, not read from a page, and a
 * negative change such as -12.5 must stay numeric.
 */

export type CsvValue = string | number | null | undefined

const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]/

export const CSV_LINE_END = '\r\n'
/** Lets Excel detect UTF-8, so names such as "Böker" or "€" survive. */
export const CSV_BOM = '﻿'

export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : ''
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** One CSV record including its line ending. */
export function csvLine(values: readonly CsvValue[]): string {
  return values.map(csvField).join(',') + CSV_LINE_END
}
