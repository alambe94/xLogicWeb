// SPDX-License-Identifier: GPL-3.0-or-later
const decimalPowers: Readonly<Record<string, number>> = {k: 3, m: 6, g: 9};

/** Expand a decimal suffix without rounding the digits or changing the field's base unit. */
export function expandDecimalSuffix(text: string): string | undefined {
  const match = /^([+-]?)(\d*\.?\d+)\s*([kmg])$/i.exec(text.trim());
  if (!match) return undefined;
  const [whole, fraction = ''] = match[2]!.split('.');
  const power = decimalPowers[match[3]!.toLowerCase()]!;
  const integer = (whole + fraction.slice(0, power).padEnd(power, '0')).replace(/^0+(?=\d)/, '');
  const remainder = fraction.slice(power).replace(/0+$/, '');
  return (match[1] === '-' ? '-' : '') + integer + (remainder ? '.' + remainder : '');
}

/** Parse a whole sample count using decimal SI units or numeric exponent notation. */
export function parseSampleCount(text: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const match = /^(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+)|\s*([kmg]))?$/i.exec(text.trim());
  if (!match) return undefined;
  const [whole, fraction = ''] = match[1].split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return undefined;
  // Shift the decimal point before converting to Number so fractional samples
  // near the safe-integer limit cannot round to a valid count.
  const significant = digits.replace(/0+$/, '');
  const unitPower = decimalPowers[match[3]?.toLowerCase() ?? ''] ?? 0;
  const power = (match[2] === undefined ? unitPower : Number(match[2]))
    - fraction.length + digits.length - significant.length;
  if (power < 0 || significant.length + power > 16) return undefined;
  const count = Number(significant) * 10 ** power;
  return Number.isSafeInteger(count) && count <= maximum ? count : undefined;
}
