import { assessRisk, RiskInput, SAFETY_GUIDANCE } from './risk';

const clean: RiskInput = {
  title: 'Wooden desk',
  description: 'Solid oak desk, a few scratches. Collection from my flat.',
  priceMinor: 6000,
  isFree: false,
  condition: 'GOOD',
};

describe('risk engine', () => {
  it('reports no major signals for an ordinary listing, without calling it safe', () => {
    const r = assessRisk(clean);
    expect(r.level).toBe('NO_MAJOR_SIGNALS');
    expect(r.label).toBe('No major risk signals detected');
    expect(r.signals).toHaveLength(0);
  });

  it('flags advance-payment language as caution', () => {
    const r = assessRisk({ ...clean, description: 'Please send a deposit via gift card first.' });
    expect(r.level).toBe('EXERCISE_CAUTION');
    expect(r.signals.map((s) => s.code)).toContain('ADVANCE_PAYMENT_MENTIONED');
  });

  it('escalates to under review when several signals combine', () => {
    const r = assessRisk({
      ...clean,
      description: 'Western Union only, message me on WhatsApp',
      sellerAccountAgeHours: 2,
      sellerListingsLast24h: 9,
      sameContentBySeller: 4,
    });
    expect(r.level).toBe('UNDER_REVIEW');
    expect(r.label).toBe('Under review');
  });

  it('flags many distinct reporters', () => {
    expect(assessRisk({ ...clean, openDistinctReporters: 3 }).level).toBe('EXERCISE_CAUTION');
    expect(assessRisk({ ...clean, openDistinctReporters: 5 }).level).toBe('UNDER_REVIEW');
  });

  it('flags unusually low prices only with enough comparable evidence', () => {
    const lowWith = assessRisk({ ...clean, priceMinor: 500, comparableMedianMinor: 10000, comparableSampleSize: 8 });
    expect(lowWith.signals.map((s) => s.code)).toContain('UNUSUALLY_LOW_PRICE');
    const lowWithout = assessRisk({ ...clean, priceMinor: 500, comparableMedianMinor: 10000, comparableSampleSize: 2 });
    expect(lowWithout.signals).toHaveLength(0);
  });

  it('does not treat free items as an unusual low price', () => {
    const r = assessRisk({ ...clean, priceMinor: 0, isFree: true, comparableMedianMinor: 10000, comparableSampleSize: 10 });
    expect(r.signals).toHaveLength(0);
  });

  it('detects contradictory information without false-positive on "free delivery"', () => {
    expect(assessRisk({ ...clean, title: 'FREE sofa', priceMinor: 5000 }).signals.map((s) => s.code)).toContain('CONTRADICTORY_PRICE');
    expect(assessRisk({ ...clean, title: 'Sofa with free delivery', priceMinor: 5000 }).signals).toHaveLength(0);
    expect(assessRisk({ ...clean, condition: 'NEW', description: 'screen is cracked' }).signals.map((s) => s.code)).toContain(
      'CONTRADICTORY_CONDITION',
    );
  });

  it('uses neutral wording that describes the listing, never accuses a person', () => {
    const r = assessRisk({ ...clean, description: 'deposit required', openDistinctReporters: 6 });
    for (const s of r.signals) expect(s.message).not.toMatch(/scammer|criminal|fraudster|thief/i);
  });

  it('ships safety guidance', () => {
    expect(SAFETY_GUIDANCE.join(' ')).toMatch(/public place/);
    expect(SAFETY_GUIDANCE.join(' ')).toMatch(/before you pay/);
  });
});
