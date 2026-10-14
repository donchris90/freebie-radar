import {
  buildEvidence,
  Comparable,
  MIN_COMPARABLES,
  scoreDeal,
  ScoringListing,
  selectComparables,
} from './scoring';

const NOW = new Date('2026-10-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const listing = (over: Partial<ScoringListing> = {}): ScoringListing => ({
  id: 'L1',
  priceMinor: 4000,
  currency: 'USD',
  countryCode: 'US',
  categoryKey: 'electronics',
  condition: 'GOOD',
  status: 'ACTIVE',
  risk: 'NO_MAJOR_SIGNALS',
  lastConfirmedAt: hoursAgo(2),
  ...over,
});

const comps = (prices: number[], over: Partial<Comparable> = {}): Comparable[] =>
  prices.map((p, i) => ({
    id: `C${i}`,
    priceMinor: p,
    currency: 'USD',
    countryCode: 'US',
    categoryKey: 'electronics',
    observedAt: daysAgo(5),
    ...over,
  }));

describe('comparable eligibility', () => {
  it('requires the same currency, country and category and recent observations', () => {
    const l = listing();
    const all: Comparable[] = [
      ...comps([8000, 9000]),
      ...comps([8000], { currency: 'GBP' }),
      ...comps([8000], { countryCode: 'GB' }),
      ...comps([8000], { categoryKey: 'furniture' }),
      ...comps([8000], { observedAt: daysAgo(120) }),
      ...comps([8000], { observedAt: new Date(NOW.getTime() + 86_400_000) }), // future-dated
      ...comps([0]), // free items are not price evidence
      { ...comps([8000])[0], id: 'L1' }, // the listing itself
    ];
    expect(selectComparables(l, all, NOW)).toHaveLength(2);
  });

  it('is not eligible below the minimum sample size and says why', () => {
    const ev = buildEvidence(listing(), comps([8000, 8500, 9000, 9500]), NOW);
    expect(ev.eligible).toBe(false);
    expect(ev.sampleSize).toBe(MIN_COMPARABLES - 1);
    expect(ev.medianMinor).toBeNull();
    expect(ev.limitations[0]).toMatch(/at least 5/);
  });

  it('computes median and range and excludes extreme outliers', () => {
    const ev = buildEvidence(listing(), comps([8000, 8200, 8500, 8800, 9000, 9200, 9500, 500000]), NOW);
    expect(ev.eligible).toBe(true);
    expect(ev.highMinor).toBeLessThan(500000);
    expect(ev.limitations.join(' ')).toMatch(/outlier/);
    expect(ev.medianMinor).toBeGreaterThan(8000);
    expect(ev.medianMinor).toBeLessThan(9500);
  });
});

describe('scoreDeal', () => {
  const good = comps([8000, 8500, 8500, 9000, 9500, 8000, 8800]);

  it('scores a cheap, fresh, good-condition item highly with a plain-language explanation', () => {
    const r = scoreDeal(listing({ priceMinor: 4000 }), good, { now: NOW, distanceKm: 3 });
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(75);
    expect(r.explanation).toMatch(/^Deal Score: \d+\/100 — Listed at \$40\.00 compared with 7 comparable listings/);
    expect(r.explanation).toMatch(/median \$85\.00, range \$80\.00–\$95\.00/);
  });

  it('scores an overpriced item low', () => {
    const r = scoreDeal(listing({ priceMinor: 12000 }), good, { now: NOW });
    expect(r.factors.price.points).toBe(0);
    expect(r.score!).toBeLessThan(50);
  });

  it('never invents a score without enough evidence', () => {
    const r = scoreDeal(listing(), comps([8000, 9000]), { now: NOW });
    expect(r.score).toBeNull();
    expect(r.explanation).toMatch(/^No Deal Score yet/);
  });

  it('does not score when the price is missing (unknown is not free)', () => {
    const r = scoreDeal(listing({ priceMinor: null }), good, { now: NOW });
    expect(r.score).toBeNull();
    expect(r.explanation).toMatch(/did not state a price/);
  });

  it('scores a free item against paid comparables without treating free as automatically great', () => {
    const r = scoreDeal(listing({ priceMinor: 0, condition: 'FOR_PARTS', lastConfirmedAt: hoursAgo(150) }), good, { now: NOW, distanceKm: 45 });
    expect(r.score).not.toBeNull();
    expect(r.explanation).toMatch(/Listed free/);
    expect(r.score!).toBeLessThan(80); // poor condition, stale, far away
  });

  it('does not score unavailable listings', () => {
    for (const status of ['REPORTED_UNAVAILABLE', 'CONFIRMED_UNAVAILABLE', 'REMOVED', 'UNDER_REVIEW'] as const) {
      expect(scoreDeal(listing({ status }), good, { now: NOW }).score).toBeNull();
    }
  });

  it('caps possibly-expired listings and says so', () => {
    const r = scoreDeal(listing({ status: 'POSSIBLY_EXPIRED' }), good, { now: NOW });
    expect(r.score!).toBeLessThanOrEqual(50);
    expect(r.explanation).toMatch(/may no longer be available/);
  });

  it('applies reduced trust and unavailable-report penalties', () => {
    const clean = scoreDeal(listing(), good, { now: NOW }).score!;
    const risky = scoreDeal(listing({ risk: 'EXERCISE_CAUTION', openUnavailableReports: 2 }), good, { now: NOW }).score!;
    expect(risky).toBeLessThan(clean);
  });

  it('is deterministic and bounded to 0-100', () => {
    const a = scoreDeal(listing(), good, { now: NOW });
    const b = scoreDeal(listing(), good, { now: NOW });
    expect(a).toEqual(b);
    expect(a.score!).toBeGreaterThanOrEqual(0);
    expect(a.score!).toBeLessThanOrEqual(100);
  });

  it('does not mix currencies: GBP comparables give no evidence for a USD listing', () => {
    const r = scoreDeal(listing(), comps([8000, 8500, 8500, 9000, 9500, 8000], { currency: 'GBP' }), { now: NOW });
    expect(r.score).toBeNull();
  });

  it('exposes the factor breakdown so every point is explainable', () => {
    const r = scoreDeal(listing(), good, { now: NOW, distanceKm: 1 });
    const sum = Object.values(r.factors).reduce((s, f) => s + f.points, 0);
    expect(sum).toBe(r.score);
    expect(Object.keys(r.factors)).toEqual(
      expect.arrayContaining(['price', 'condition', 'freshness', 'distance', 'evidence', 'trust']),
    );
  });
});
