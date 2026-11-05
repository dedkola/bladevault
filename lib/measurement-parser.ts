function parseNumber(value: string): number | undefined {
  const fraction = value.match(/^([+-]?)(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/)
  if (fraction) {
    const denominator = Number(fraction[4])
    if (!Number.isFinite(denominator) || denominator === 0) return undefined
    const magnitude =
      Number(fraction[2] ?? 0) + Number(fraction[3]) / denominator
    if (!Number.isFinite(magnitude)) return undefined
    return fraction[1] === '-' ? -magnitude : magnitude
  }

  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function measurementPattern(unit: string): RegExp {
  // Match a complete decimal or fraction, never the tail of malformed notation.
  const amount = String.raw`[+-]?(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?|[.,]\d+)`
  return new RegExp(String.raw`(?<![\w.,/+-])(${amount})\s*(?:${unit})`, 'i')
}

const MEASUREMENT_PATTERNS = {
  inches: measurementPattern(String.raw`in(?:ch(?:es)?)?\b\.?|''|["″“”]`),
  millimeters: measurementPattern(String.raw`mm\b`),
  centimeters: measurementPattern(String.raw`cm\b`),
  ounces: measurementPattern(String.raw`(?:oz|ounces?)\b`),
  kilograms: measurementPattern(String.raw`kg\b`),
  pounds: measurementPattern(String.raw`(?:lb|lbs|pounds?)\b`),
  grams: measurementPattern(String.raw`(?:g|grams?)\b`),
}

function matchMeasurement(value: string, pattern: RegExp): number | undefined {
  // Retailers often omit spaces around the separator in dual-unit values.
  // Separate only after a unit marker so fraction/malformed-number guards hold.
  const separated = value.replace(
    /((?:(?<=\d)|\b)(?:in(?:ch(?:es)?)?|mm|cm|oz|g)\.?|''|["″“”])\s*\/\s*(?=[+-]?(?:\d|[.,]))/gi,
    '$1 / ',
  )
  const match = separated.match(pattern)
  return match?.[1] ? parseNumber(match[1]) : undefined
}

export function parseLengthToInches(value: string): number | undefined {
  const inches = matchMeasurement(value, MEASUREMENT_PATTERNS.inches)
  if (inches !== undefined) return inches

  const millimeters = matchMeasurement(value, MEASUREMENT_PATTERNS.millimeters)
  if (millimeters !== undefined) return millimeters / 25.4

  const centimeters = matchMeasurement(value, MEASUREMENT_PATTERNS.centimeters)
  return centimeters === undefined ? undefined : centimeters / 2.54
}

export function parseLengthToMillimeters(value: string): number | undefined {
  const millimeters = matchMeasurement(value, MEASUREMENT_PATTERNS.millimeters)
  if (millimeters !== undefined) return millimeters

  const centimeters = matchMeasurement(value, MEASUREMENT_PATTERNS.centimeters)
  if (centimeters !== undefined) return centimeters * 10

  const inches = parseLengthToInches(value)
  return inches === undefined ? undefined : inches * 25.4
}

export function parseWeightToOunces(value: string): number | undefined {
  const ounces = matchMeasurement(value, MEASUREMENT_PATTERNS.ounces)
  if (ounces !== undefined) return ounces

  const kilograms = matchMeasurement(value, MEASUREMENT_PATTERNS.kilograms)
  if (kilograms !== undefined) return kilograms * 35.27396195

  const pounds = matchMeasurement(value, MEASUREMENT_PATTERNS.pounds)
  if (pounds !== undefined) return pounds * 16

  const grams = matchMeasurement(value, MEASUREMENT_PATTERNS.grams)
  return grams === undefined ? undefined : grams / 28.349523125
}
