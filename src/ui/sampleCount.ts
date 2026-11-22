// SPDX-License-Identifier: GPL-3.0-or-later
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
  const unitPower = { k: 3, m: 6, g: 9 }[match[3]?.toLowerCase() ?? ''] ?? 0;
  const power = (match[2] === undefined ? unitPower : Number(match[2]))
    - fraction.length + digits.length - significant.length;
  if (power < 0 || significant.length + power > 16) return undefined;
  const count = Number(significant) * 10 ** power;
  return Number.isSafeInteger(count) && count <= maximum ? count : undefined;
}
