import {
  canTransition,
  evaluateExpiry,
  freshnessLabel,
  isPubliclyListed,
  LifecycleError,
  reportsReachThreshold,
  transition,
} from './lifecycle';

const NOW = new Date('2026-10-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('lifecycle transitions', () => {
  it('moves through the expected states on evidence', () => {
    expect(transition('ACTIVE', 'AUTO_EXPIRED')).toBe('POSSIBLY_EXPIRED');
    expect(transition('POSSIBLY_EXPIRED', 'SELLER_CONFIRMED')).toBe('ACTIVE');
    expect(transition('ACTIVE', 'RECHECK_GONE')).toBe('CONFIRMED_UNAVAILABLE');
    expect(transition('ACTIVE', 'REPORTS_THRESHOLD_REACHED')).toBe('REPORTED_UNAVAILABLE');
    expect(transition('UNDER_REVIEW', 'MODERATOR_RESTORE')).toBe('ACTIVE');
  });

  it('does not let a provider refresh revive moderated or confirmed-unavailable listings', () => {
    for (const s of ['REMOVED', 'UNDER_REVIEW', 'CONFIRMED_UNAVAILABLE'] as const) {
      expect(canTransition(s, 'PROVIDER_REFRESH')).toBe(false);
      expect(() => transition(s, 'PROVIDER_REFRESH')).toThrow(LifecycleError);
    }
  });

  it('does not let a mere recheck-ok revive a reported-unavailable listing', () => {
    expect(canTransition('REPORTED_UNAVAILABLE', 'RECHECK_OK')).toBe(false);
  });

  it('only shows active and possibly-expired listings', () => {
    expect(isPubliclyListed('ACTIVE')).toBe(true);
    expect(isPubliclyListed('POSSIBLY_EXPIRED')).toBe(true);
    for (const s of ['REPORTED_UNAVAILABLE', 'CONFIRMED_UNAVAILABLE', 'REMOVED', 'UNDER_REVIEW'] as const) {
      expect(isPubliclyListed(s)).toBe(false);
    }
  });
});

describe('expiry rules', () => {
  const rule = { expireAfterHours: 48, retireAfterHours: 72 };

  it('keeps recently confirmed listings active', () => {
    expect(evaluateExpiry({ status: 'ACTIVE', lastConfirmedAt: hoursAgo(10) }, rule, NOW)).toBeNull();
  });
  it('expires listings after the source-specific silence window', () => {
    expect(evaluateExpiry({ status: 'ACTIVE', lastConfirmedAt: hoursAgo(48) }, rule, NOW)).toBe('AUTO_EXPIRED');
    expect(evaluateExpiry({ status: 'ACTIVE', lastConfirmedAt: hoursAgo(47) }, rule, NOW)).toBeNull();
  });
  it('expires at the seller-set expiry time even if recently confirmed', () => {
    expect(evaluateExpiry({ status: 'ACTIVE', lastConfirmedAt: hoursAgo(1), expiresAt: hoursAgo(0.5) }, rule, NOW)).toBe('AUTO_EXPIRED');
    expect(evaluateExpiry({ status: 'ACTIVE', lastConfirmedAt: hoursAgo(1), expiresAt: new Date(NOW.getTime() + 1000) }, rule, NOW)).toBeNull();
  });
  it('retires long-stale possibly-expired listings', () => {
    expect(evaluateExpiry({ status: 'POSSIBLY_EXPIRED', lastConfirmedAt: hoursAgo(121) }, rule, NOW)).toBe('AUTO_RETIRED');
    expect(evaluateExpiry({ status: 'POSSIBLY_EXPIRED', lastConfirmedAt: hoursAgo(60) }, rule, NOW)).toBeNull();
  });
  it('never auto-changes moderated or confirmed states', () => {
    for (const s of ['REMOVED', 'UNDER_REVIEW', 'CONFIRMED_UNAVAILABLE'] as const) {
      expect(evaluateExpiry({ status: s, lastConfirmedAt: hoursAgo(9999) }, rule, NOW)).toBeNull();
    }
  });
  it('requires several distinct reporters before reporting unavailable', () => {
    expect(reportsReachThreshold(1)).toBe(false);
    expect(reportsReachThreshold(2)).toBe(true);
  });
});

describe('freshnessLabel', () => {
  it('uses "Posted" when nothing has confirmed it since', () => {
    const f = freshnessLabel(NOW, hoursAgo(2), hoursAgo(2), 'ACTIVE');
    expect(f.label).toBe('Posted 2 hours ago');
    expect(f.stale).toBe(false);
  });
  it('uses "Last confirmed" when confirmation postdates posting', () => {
    const f = freshnessLabel(NOW, hoursAgo(72), hoursAgo(24), 'ACTIVE');
    expect(f.label).toBe('Last confirmed yesterday');
  });
  it('warns on possibly-expired listings', () => {
    const f = freshnessLabel(NOW, hoursAgo(200), hoursAgo(200), 'POSSIBLY_EXPIRED');
    expect(f.label).toMatch(/^May no longer be available · posted/);
    expect(f.stale).toBe(true);
  });
  it('handles just-now and minutes', () => {
    expect(freshnessLabel(NOW, NOW, NOW, 'ACTIVE').label).toMatch(/Posted (now|in 0 seconds|0 seconds ago)/);
    expect(freshnessLabel(NOW, hoursAgo(0.25), hoursAgo(0.25), 'ACTIVE').label).toBe('Posted 15 minutes ago');
  });
});
