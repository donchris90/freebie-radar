/**
 * Listing lifecycle. Status changes only on evidence: provider updates, seller confirmations, user
 * reports, moderators. A page merely still existing is never evidence of availability.
 */

export type ListingStatus =
  | 'ACTIVE'
  | 'POSSIBLY_EXPIRED'
  | 'REPORTED_UNAVAILABLE'
  | 'CONFIRMED_UNAVAILABLE'
  | 'REMOVED'
  | 'UNDER_REVIEW';

export type LifecycleEvent =
  | 'PROVIDER_REFRESH'
  | 'SELLER_CONFIRMED'
  | 'RECHECK_OK'
  | 'RECHECK_GONE'
  | 'SELLER_MARKED_UNAVAILABLE'
  | 'REPORTS_THRESHOLD_REACHED'
  | 'AUTO_EXPIRED'
  | 'AUTO_RETIRED'
  | 'MODERATOR_UNDER_REVIEW'
  | 'MODERATOR_REMOVE'
  | 'MODERATOR_RESTORE';

export class LifecycleError extends Error {}

const TRANSITIONS: Record<LifecycleEvent, Partial<Record<ListingStatus, ListingStatus>>> = {
  // Positive evidence revives stale or reported listings but never overrides a terminal/moderated state.
  PROVIDER_REFRESH: { ACTIVE: 'ACTIVE', POSSIBLY_EXPIRED: 'ACTIVE', REPORTED_UNAVAILABLE: 'ACTIVE' },
  SELLER_CONFIRMED: { ACTIVE: 'ACTIVE', POSSIBLY_EXPIRED: 'ACTIVE', REPORTED_UNAVAILABLE: 'ACTIVE' },
  RECHECK_OK: { ACTIVE: 'ACTIVE', POSSIBLY_EXPIRED: 'ACTIVE' },
  RECHECK_GONE: { ACTIVE: 'CONFIRMED_UNAVAILABLE', POSSIBLY_EXPIRED: 'CONFIRMED_UNAVAILABLE', REPORTED_UNAVAILABLE: 'CONFIRMED_UNAVAILABLE' },
  SELLER_MARKED_UNAVAILABLE: { ACTIVE: 'CONFIRMED_UNAVAILABLE', POSSIBLY_EXPIRED: 'CONFIRMED_UNAVAILABLE', REPORTED_UNAVAILABLE: 'CONFIRMED_UNAVAILABLE' },
  REPORTS_THRESHOLD_REACHED: { ACTIVE: 'REPORTED_UNAVAILABLE', POSSIBLY_EXPIRED: 'REPORTED_UNAVAILABLE' },
  AUTO_EXPIRED: { ACTIVE: 'POSSIBLY_EXPIRED' },
  AUTO_RETIRED: { POSSIBLY_EXPIRED: 'REMOVED', REPORTED_UNAVAILABLE: 'REMOVED' },
  MODERATOR_UNDER_REVIEW: { ACTIVE: 'UNDER_REVIEW', POSSIBLY_EXPIRED: 'UNDER_REVIEW', REPORTED_UNAVAILABLE: 'UNDER_REVIEW' },
  MODERATOR_REMOVE: {
    ACTIVE: 'REMOVED',
    POSSIBLY_EXPIRED: 'REMOVED',
    REPORTED_UNAVAILABLE: 'REMOVED',
    CONFIRMED_UNAVAILABLE: 'REMOVED',
    UNDER_REVIEW: 'REMOVED',
  },
  MODERATOR_RESTORE: { UNDER_REVIEW: 'ACTIVE', REMOVED: 'ACTIVE' },
};

export function transition(from: ListingStatus, event: LifecycleEvent): ListingStatus {
  const to = TRANSITIONS[event][from];
  if (!to) throw new LifecycleError(`Event ${event} is not allowed from status ${from}`);
  return to;
}

export function canTransition(from: ListingStatus, event: LifecycleEvent): boolean {
  return TRANSITIONS[event][from] !== undefined;
}

/** Feeds show active and possibly-expired (with a warning label). Everything else is hidden. */
export function isPubliclyListed(status: ListingStatus): boolean {
  return status === 'ACTIVE' || status === 'POSSIBLY_EXPIRED';
}

export interface ExpiryRule {
  /** Hours of silence (no positive evidence) before an active listing becomes "possibly expired". */
  expireAfterHours: number;
  /** Extra hours a possibly-expired listing stays visible before it is retired. */
  retireAfterHours?: number;
}

export interface ExpiryInput {
  status: ListingStatus;
  lastConfirmedAt: Date;
  expiresAt?: Date | null;
}

const HOUR = 3_600_000;

/** Decides which automatic event, if any, applies right now. Pure: callers persist the result. */
export function evaluateExpiry(input: ExpiryInput, rule: ExpiryRule, now: Date): 'AUTO_EXPIRED' | 'AUTO_RETIRED' | null {
  const silentHours = (now.getTime() - input.lastConfirmedAt.getTime()) / HOUR;
  if (input.status === 'ACTIVE') {
    const pastSellerExpiry = input.expiresAt ? now.getTime() >= input.expiresAt.getTime() : false;
    if (pastSellerExpiry || silentHours >= rule.expireAfterHours) return 'AUTO_EXPIRED';
    return null;
  }
  if (input.status === 'POSSIBLY_EXPIRED' || input.status === 'REPORTED_UNAVAILABLE') {
    const retire = rule.retireAfterHours ?? 168;
    if (silentHours >= rule.expireAfterHours + retire) return 'AUTO_RETIRED';
  }
  return null;
}

/** One report never takes a listing down; a threshold of distinct reporters is required. */
export function reportsReachThreshold(distinctReporters: number, threshold = 2): boolean {
  return distinctReporters >= threshold;
}

export interface Freshness {
  label: string;
  ageHours: number;
  stale: boolean;
}

function relative(now: Date, then: Date, locale: string): string {
  const diffMs = now.getTime() - then.getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return rtf.format(0, 'second');
  if (mins < 60) return rtf.format(-mins, 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, 'day');
  return rtf.format(-Math.floor(days / 30), 'month');
}

/** Labels use real timestamps only. "Last confirmed" is shown only when confirmation postdates posting. */
export function freshnessLabel(
  now: Date,
  postedAt: Date,
  lastConfirmedAt: Date,
  status: ListingStatus,
  locale = 'en-US',
): Freshness {
  const confirmedLater = lastConfirmedAt.getTime() - postedAt.getTime() > HOUR;
  const reference = confirmedLater ? lastConfirmedAt : postedAt;
  const ageHours = Math.max(0, (now.getTime() - lastConfirmedAt.getTime()) / HOUR);
  const rel = relative(now, reference, locale);
  const base = confirmedLater ? `Last confirmed ${rel}` : `Posted ${rel}`;
  if (status === 'POSSIBLY_EXPIRED') {
    return { label: `May no longer be available · ${base.charAt(0).toLowerCase()}${base.slice(1)}`, ageHours, stale: true };
  }
  return { label: base, ageHours, stale: false };
}
