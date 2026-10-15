import { addInterval, amountMatches, entitledTier } from './billing';

const now = new Date('2026-10-15T12:00:00Z');
const d = (s: string) => new Date(s);

describe('entitledTier', () => {
  it('is free without a subscription', () => {
    expect(entitledTier(null, now, 3)).toBe('FREE');
    expect(entitledTier({ tier: 'PREMIUM', status: 'NONE', currentPeriodEnd: d('2027-01-01') }, now, 3)).toBe('FREE');
    expect(entitledTier({ tier: 'PREMIUM', status: 'ACTIVE', currentPeriodEnd: null }, now, 3)).toBe('FREE');
  });
  it('is premium while paid through', () => {
    expect(entitledTier({ tier: 'PREMIUM', status: 'ACTIVE', currentPeriodEnd: d('2026-11-01') }, now, 3)).toBe('PREMIUM');
  });
  it('keeps access after cancelling until the paid period ends, then drops', () => {
    expect(entitledTier({ tier: 'PREMIUM', status: 'CANCELLED', currentPeriodEnd: d('2026-10-20') }, now, 3)).toBe('PREMIUM');
    expect(entitledTier({ tier: 'PREMIUM', status: 'CANCELLED', currentPeriodEnd: d('2026-10-15T11:59:59Z') }, now, 3)).toBe('FREE');
  });
  it('an active subscription past its end date lapses', () => {
    expect(entitledTier({ tier: 'PREMIUM', status: 'ACTIVE', currentPeriodEnd: d('2026-10-01') }, now, 3)).toBe('FREE');
  });
  it('gives a failed renewal a grace period, then ends it', () => {
    const sub = { tier: 'PREMIUM' as const, status: 'PAST_DUE' as const, currentPeriodEnd: d('2026-10-14T12:00:00Z') };
    expect(entitledTier(sub, now, 3)).toBe('PREMIUM');
    expect(entitledTier(sub, d('2026-10-17T11:00:00Z'), 3)).toBe('PREMIUM');
    expect(entitledTier(sub, d('2026-10-17T12:00:01Z'), 3)).toBe('FREE');
    expect(entitledTier(sub, now, 0)).toBe('FREE');
  });
});

describe('helpers', () => {
  it('adds intervals', () => {
    expect(addInterval(d('2026-10-15T00:00:00Z'), 'monthly').toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(addInterval(d('2026-10-15T00:00:00Z'), 'annual').toISOString()).toBe('2027-10-15T00:00:00.000Z');
  });
  it('requires the exact amount', () => {
    expect(amountMatches(39900, 39900)).toBe(true);
    expect(amountMatches(39900, 100)).toBe(false);
    expect(amountMatches(undefined, 100)).toBe(false);
    expect(amountMatches(100, 100.5)).toBe(false);
  });
});
