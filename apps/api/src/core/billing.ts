import type { Tier } from '../domain/models';

/**
 * What a subscription entitles its owner to, decided in one place from facts we hold. Pure.
 *
 * - ACTIVE and paid through a future date: premium.
 * - Cancelled or "not renewing" but paid through a future date: still premium until that date.
 * - PAST_DUE (a renewal charge failed): premium for a short grace period after the paid-through date.
 * - Anything else: free.
 */
export type SubStatus = 'NONE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';

export interface EntitlementInput {
  tier: Tier;
  status: SubStatus;
  currentPeriodEnd: Date | null;
}

const DAY = 86_400_000;

export function entitledTier(sub: EntitlementInput | null, now: Date, graceDays: number): Tier {
  if (!sub || sub.status === 'NONE' || !sub.currentPeriodEnd) return 'FREE';
  const end = sub.currentPeriodEnd.getTime();
  if (sub.status === 'ACTIVE' || sub.status === 'CANCELLED') return now.getTime() < end ? sub.tier : 'FREE';
  if (sub.status === 'PAST_DUE') return now.getTime() < end + graceDays * DAY ? sub.tier : 'FREE';
  return 'FREE';
}

/** Adds one billing interval. Used only as a fallback when the provider has not told us the next charge date. */
export function addInterval(from: Date, interval: 'monthly' | 'annual'): Date {
  const d = new Date(from.getTime());
  if (interval === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** The amount actually charged must equal the price we showed. Anything else never grants an entitlement. */
export function amountMatches(expectedMinor: number | undefined, paidMinor: number): boolean {
  return expectedMinor !== undefined && Number.isInteger(paidMinor) && paidMinor === expectedMinor;
}
