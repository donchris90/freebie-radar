import {
  applyBasisPoints,
  currencyExponent,
  formatMinor,
  formatPriceLabel,
  MoneyError,
  parseMajorToMinor,
  sumMinor,
} from './money';

describe('money', () => {
  it('knows currency minor-unit exponents', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('rejects invalid currency codes', () => {
    expect(() => currencyExponent('US')).toThrow(MoneyError);
    expect(() => currencyExponent('US1')).toThrow(MoneyError);
  });

  it('parses decimal strings without floating point error', () => {
    expect(parseMajorToMinor('40', 'USD')).toBe(4000);
    expect(parseMajorToMinor('0.10', 'USD')).toBe(10);
    expect(parseMajorToMinor('1,299.99', 'USD')).toBe(129999);
    expect(parseMajorToMinor('500', 'JPY')).toBe(500);
    // classic float trap: 0.1 + 0.2 style values stay exact
    expect(parseMajorToMinor('19.99', 'GBP')).toBe(1999);
  });

  it('rejects bad amounts', () => {
    expect(() => parseMajorToMinor('-5', 'USD')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('abc', 'USD')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('1.234', 'USD')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('10.5', 'JPY')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('99999999999', 'USD')).toThrow(MoneyError);
  });

  it('formats per currency and locale', () => {
    expect(formatMinor(4000, 'USD', 'en-US')).toBe('$40.00');
    expect(formatMinor(1999, 'GBP', 'en-GB')).toBe('£19.99');
    expect(formatMinor(500, 'JPY', 'ja-JP')).toMatch(/500/);
  });

  it('labels free and unknown prices distinctly', () => {
    expect(formatPriceLabel(0, 'USD')).toBe('Free');
    expect(formatPriceLabel(null, 'USD')).toBe('Price not stated');
    expect(formatPriceLabel(2500, 'USD')).toBe('$25.00');
  });

  it('applies basis points with half-up integer rounding', () => {
    expect(applyBasisPoints(10000, 1300)).toBe(1300);
    expect(applyBasisPoints(1999, 1000)).toBe(200); // 199.9 -> 200
    expect(applyBasisPoints(1, 5000)).toBe(1); // 0.5 -> 1
    expect(applyBasisPoints(0, 1300)).toBe(0);
  });

  it('sums safely and rejects invalid values', () => {
    expect(sumMinor(1, 2, 3)).toBe(6);
    expect(() => sumMinor(1, -2)).toThrow(MoneyError);
    expect(() => sumMinor(1.5)).toThrow(MoneyError);
  });
});
