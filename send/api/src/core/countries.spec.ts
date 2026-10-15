import { COUNTRY_CATALOG, DEFAULT_LAUNCH_COUNTRIES } from './countries';
import { assertCurrency } from './money';

describe('country catalog', () => {
  it('has unique two-letter codes', () => {
    const codes = COUNTRY_CATALOG.map((x) => x.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it('uses real ISO 4217 currencies and IANA time zones', () => {
    for (const x of COUNTRY_CATALOG) {
      expect(() => assertCurrency(x.currency)).not.toThrow();
      expect(() => new Intl.DateTimeFormat('en', { timeZone: x.defaultTimeZone })).not.toThrow();
      expect(['mi', 'km']).toContain(x.distanceUnit);
    }
  });

  it('launches in the US, Canada and the UK', () => {
    expect(DEFAULT_LAUNCH_COUNTRIES).toEqual(['US', 'CA', 'GB']);
    for (const code of DEFAULT_LAUNCH_COUNTRIES) expect(COUNTRY_CATALOG.some((x) => x.code === code)).toBe(true);
  });
});
