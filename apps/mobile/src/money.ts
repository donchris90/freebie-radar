/** Client-side convenience only. The server re-validates every amount and is authoritative. */
export function exponent(currency: string): number {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}
/** "12.50" -> 1250 without floats. Returns null for invalid input. */
export function toMinor(input: string, currency: string): number | null {
  const v = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [w, f = ''] = v.split('.');
  const exp = exponent(currency);
  if (f.length > exp) return null;
  const n = Number(w + f.padEnd(exp, '0'));
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
}
export const COUNTRY_CURRENCY: Record<string, string> = { US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NG: 'NGN' };
export const currencyForCountry = (cc?: string) => COUNTRY_CURRENCY[(cc ?? '').toUpperCase()] ?? 'USD';
