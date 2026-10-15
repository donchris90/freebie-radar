import type { ClaimStatus } from '../domain/models';

/**
 * Reservation rules, kept free of storage so they can be tested on their own.
 *
 * A claim goes HELD (the collector tapped "I'll take it") -> CONFIRMED (the giver agreed) -> COLLECTED.
 * It can end early as CANCELLED, lapse as EXPIRED, or be reported as NO_SHOW by the giver.
 */
export const ACTIVE_CLAIM_STATUSES: ClaimStatus[] = ['HELD', 'CONFIRMED'];
export const isActiveClaim = (s: ClaimStatus) => s === 'HELD' || s === 'CONFIRMED';

/** A giver may report a no-show only this long after confirming, so it cannot be used the moment a pickup is agreed. */
export const NO_SHOW_WAIT_MS = 30 * 60_000;
export function canReportNoShow(confirmedAt: Date | null, now: Date): boolean {
  return !!confirmedAt && now.getTime() - confirmedAt.getTime() >= NO_SHOW_WAIT_MS;
}

/** How many finished reservations are needed before a collector gets a reliability label. */
export const MIN_OUTCOMES = 3;

export interface Tally {
  collected: number;
  noShow: number;
  lateCancel: number;
  given: number;
}

export type ReliabilityLabel = 'NEW' | 'RELIABLE' | 'MOSTLY_RELIABLE' | 'UNRELIABLE';
export interface Reliability {
  /** Reservations that had a clear result: collected, reported as a no-show, or cancelled after the giver confirmed. */
  outcomes: number;
  collected: number;
  /** 0 to 1, or null while there are too few outcomes to say anything fair. */
  rate: number | null;
  label: ReliabilityLabel;
  text: string;
}

/**
 * Honest and conservative: nothing is shown until a person has a few clear outcomes, and plain cancellations
 * before the giver confirmed, lapsed holds and cancellations by the giver never count against anyone.
 */
export function reliability(t: Tally): Reliability {
  const outcomes = t.collected + t.noShow + t.lateCancel;
  if (outcomes < MIN_OUTCOMES) {
    return { outcomes, collected: t.collected, rate: null, label: 'NEW', text: outcomes === 0 ? 'New to collecting' : `${t.collected} of ${outcomes} collected so far` };
  }
  const rate = t.collected / outcomes;
  const label: ReliabilityLabel = rate >= 0.9 ? 'RELIABLE' : rate >= 0.6 ? 'MOSTLY_RELIABLE' : 'UNRELIABLE';
  return { outcomes, collected: t.collected, rate: Math.round(rate * 100) / 100, label, text: `Collected ${t.collected} of ${outcomes} reserved items` };
}
