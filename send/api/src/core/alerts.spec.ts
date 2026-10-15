import { AlertCandidate, AlertCriteria, dedupKey, inQuietHours, isDigestDue, localHour, matchesAlert, planDelivery } from './alerts';

const criteria = (over: Partial<AlertCriteria> = {}): AlertCriteria => ({
  active: true,
  keywords: [],
  excludedWords: [],
  categories: [],
  freeOnly: false,
  conditions: [],
  sourceKeys: [],
  ...over,
});

const listing = (over: Partial<AlertCandidate> = {}): AlertCandidate => ({
  id: 'L1',
  title: 'Used MacBook Air 2019',
  description: 'Works well, small dent.',
  status: 'ACTIVE',
  priceMinor: 20000,
  currency: 'USD',
  isFree: false,
  categoryKey: 'electronics',
  condition: 'GOOD',
  lat: 40.7128,
  lng: -74.006,
  sourceKey: 'direct',
  dealScore: 82,
  ...over,
});

describe('matchesAlert', () => {
  it('matches the headline example: MacBook under $250 within 10 miles', () => {
    const c = criteria({ keywords: ['macbook'], maxPriceMinor: 25000, currency: 'USD', radiusKm: 16.09, centerLat: 40.73, centerLng: -73.99 });
    expect(matchesAlert(c, listing()).match).toBe(true);
    expect(matchesAlert(c, listing({ priceMinor: 30000 })).failed).toBe('above max price');
    expect(matchesAlert(c, listing({ lat: 41.5, lng: -74 })).failed).toBe('outside radius');
  });

  it('only matches active listings and active alerts', () => {
    expect(matchesAlert(criteria(), listing({ status: 'POSSIBLY_EXPIRED' })).match).toBe(false);
    expect(matchesAlert(criteria({ active: false }), listing()).match).toBe(false);
  });

  it('free-only requires a genuinely free listing, not an unknown price', () => {
    expect(matchesAlert(criteria({ freeOnly: true }), listing({ priceMinor: 0, isFree: true })).match).toBe(true);
    expect(matchesAlert(criteria({ freeOnly: true }), listing({ priceMinor: null })).match).toBe(false);
    expect(matchesAlert(criteria({ freeOnly: true }), listing()).match).toBe(false);
  });

  it('price bounds never match an unknown price or a different currency', () => {
    const c = criteria({ maxPriceMinor: 30000, currency: 'USD' });
    expect(matchesAlert(c, listing({ priceMinor: null })).failed).toBe('price unknown');
    expect(matchesAlert(c, listing({ currency: 'GBP' })).failed).toBe('currency mismatch');
    expect(matchesAlert(criteria({ maxPriceMinor: 30000 }), listing()).failed).toBe('currency mismatch');
  });

  it('applies min price including a free item', () => {
    const c = criteria({ minPriceMinor: 1000, currency: 'USD' });
    expect(matchesAlert(c, listing({ priceMinor: 0, isFree: true })).failed).toBe('below min price');
  });

  it('matches any keyword on word boundaries and rejects excluded words', () => {
    expect(matchesAlert(criteria({ keywords: ['thinkpad', 'macbook'] }), listing()).match).toBe(true);
    expect(matchesAlert(criteria({ keywords: ['mac'] }), listing()).match).toBe(false); // not a whole word
    expect(matchesAlert(criteria({ keywords: ['macbook'], excludedWords: ['dent'] }), listing()).failed).toBe('excluded word');
    expect(matchesAlert(criteria({ keywords: ['macbook air'] }), listing()).match).toBe(true);
  });

  it('filters by category, condition and source', () => {
    expect(matchesAlert(criteria({ categories: ['furniture'] }), listing()).failed).toBe('category');
    expect(matchesAlert(criteria({ conditions: ['NEW'] }), listing()).failed).toBe('condition');
    expect(matchesAlert(criteria({ sourceKeys: ['other'] }), listing()).failed).toBe('source');
  });

  it('requires a deal score at or above the threshold, and never matches a missing score', () => {
    expect(matchesAlert(criteria({ minDealScore: 80 }), listing()).match).toBe(true);
    expect(matchesAlert(criteria({ minDealScore: 90 }), listing()).failed).toBe('deal score');
    expect(matchesAlert(criteria({ minDealScore: 1 }), listing({ dealScore: null })).failed).toBe('deal score');
  });

  it('refuses a radius filter without a centre point', () => {
    expect(matchesAlert(criteria({ radiusKm: 10 }), listing()).failed).toBe('radius without center');
  });
});

describe('alert deduplication', () => {
  it('produces a stable key per subscription and listing', () => {
    expect(dedupKey('s1', 'l1')).toBe(dedupKey('s1', 'l1'));
    expect(dedupKey('s1', 'l1')).not.toBe(dedupKey('s2', 'l1'));
  });
});

describe('delivery planning', () => {
  const NOW = new Date('2026-10-14T21:30:00Z'); // 22:30 in Lagos (UTC+1)
  const ctx = (over = {}) => ({
    frequency: 'IMMEDIATE' as const,
    now: NOW,
    timeZone: 'Africa/Lagos',
    pushEnabled: true,
    sentLast24h: 0,
    maxPerDay: 10,
    ...over,
  });

  it('computes local hour in the user time zone', () => {
    expect(localHour(NOW, 'Africa/Lagos')).toBe(22);
    expect(localHour(NOW, 'UTC')).toBe(21);
  });

  it('handles quiet hours that wrap midnight', () => {
    expect(inQuietHours(23, 22, 7)).toBe(true);
    expect(inQuietHours(3, 22, 7)).toBe(true);
    expect(inQuietHours(12, 22, 7)).toBe(false);
    expect(inQuietHours(10, null, null)).toBe(false);
    expect(inQuietHours(10, 9, 17)).toBe(true);
  });

  it('sends immediately outside quiet hours and defers inside them', () => {
    expect(planDelivery(ctx()).action).toBe('SEND_NOW');
    expect(planDelivery(ctx({ quietHoursStart: 22, quietHoursEnd: 7 })).action).toBe('DEFER_QUIET_HOURS');
  });

  it('respects the push preference and the daily limit', () => {
    expect(planDelivery(ctx({ pushEnabled: false }))).toEqual({ action: 'SKIP', reason: 'PUSH_DISABLED' });
    expect(planDelivery(ctx({ sentLast24h: 10 }))).toEqual({ action: 'SKIP', reason: 'DAILY_LIMIT' });
  });

  it('queues digests for their next due time', () => {
    const d = planDelivery(ctx({ frequency: 'DAILY_DIGEST', lastDigestAt: new Date('2026-10-14T08:00:00Z') }));
    expect(d.action).toBe('QUEUE_DIGEST');
    if (d.action === 'QUEUE_DIGEST') expect(d.dueAt.toISOString()).toBe('2026-10-15T08:00:00.000Z');
    expect(isDigestDue('DAILY_DIGEST', NOW, new Date('2026-10-14T08:00:00Z'))).toBe(false);
    expect(isDigestDue('HOURLY_DIGEST', NOW, new Date('2026-10-14T19:00:00Z'))).toBe(true);
    expect(isDigestDue('IMMEDIATE', NOW, null)).toBe(false);
    expect(isDigestDue('DAILY_DIGEST', NOW, null)).toBe(true);
  });
});
