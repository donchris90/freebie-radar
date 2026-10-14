/**
 * Money helpers. All amounts are integers in the currency's MINOR unit (cents, pence, kobo, yen...).
 * Floating point is never used for arithmetic; Intl is used for display only.
 */

export const MAX_MINOR = 2_147_483_647; // matches Postgres INT column

export class MoneyError extends Error {}

export function assertCurrency(code: string): string {
  if (typeof code !== 'string' || !/^[A-Za-z]{3}$/.test(code)) {
    throw new MoneyError(`Invalid currency code: ${String(code)}`);
  }
  const upper = code.toUpperCase();
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: upper });
  } catch {
    throw new MoneyError(`Unsupported currency code: ${upper}`);
  }
  return upper;
}

/** Number of minor-unit digits (USD 2, JPY 0, KWD 3) per ISO 4217 as known to the runtime. */
export function currencyExponent(code: string): number {
  const upper = assertCurrency(code);
  return new Intl.NumberFormat('en', { style: 'currency', currency: upper }).resolvedOptions()
    .maximumFractionDigits as number;
}

export function assertMinor(value: number, label = 'amount'): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_MINOR) {
    throw new MoneyError(`${label} must be a non-negative integer minor-unit amount (max ${MAX_MINOR})`);
  }
  return value;
}

/**
 * Parse a decimal STRING such as "40", "40.5", "1,299.99" into minor units without floats.
 * Rejects more fractional digits than the currency allows, negatives, and non-numeric input.
 */
export function parseMajorToMinor(input: string, currency: string): number {
  const exp = currencyExponent(currency);
  if (typeof input !== 'string') throw new MoneyError('Amount must be a string');
  const cleaned = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new MoneyError(`Invalid amount: "${input}"`);
  const [whole, frac = ''] = cleaned.split('.');
  if (frac.length > exp) throw new MoneyError(`Too many decimal places for ${currency.toUpperCase()}`);
  const minorStr = whole + frac.padEnd(exp, '0');
  const value = Number(minorStr);
  if (!Number.isSafeInteger(value) || value > MAX_MINOR) throw new MoneyError('Amount is too large');
  return value;
}

/** Display only. Uses Intl so symbol placement, grouping and decimals follow the locale and currency. */
export function formatMinor(minor: number, currency: string, locale = 'en-US'): string {
  const upper = assertCurrency(currency);
  const exp = currencyExponent(upper);
  const major = minor / 10 ** exp;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: upper }).format(major);
}

/** Free is formatted as the word, not a zero amount. Unknown price is never shown as zero. */
export function formatPriceLabel(
  priceMinor: number | null,
  currency: string,
  locale = 'en-US',
  freeLabel = 'Free',
): string {
  if (priceMinor === null || priceMinor === undefined) return 'Price not stated';
  if (priceMinor === 0) return freeLabel;
  return formatMinor(priceMinor, currency, locale);
}

/** round(amount * bps / 10000) using BigInt, half-up, for non-negative inputs. */
export function applyBasisPoints(amountMinor: number, bps: number): number {
  assertMinor(amountMinor, 'amount');
  if (!Number.isInteger(bps) || bps < 0 || bps > 100_000) throw new MoneyError('Basis points out of range');
  const result = (BigInt(amountMinor) * BigInt(bps) + 5000n) / 10000n;
  return Number(result);
}

export function sumMinor(...values: number[]): number {
  let total = 0n;
  for (const v of values) total += BigInt(assertMinor(v));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError('Sum is too large');
  return Number(total);
}
