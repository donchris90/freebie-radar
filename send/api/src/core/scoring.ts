import { assertCurrency, formatMinor } from './money';

/**
 * Deterministic, explainable deal scoring. No AI is involved in the score.
 * A score is only produced when there is sufficient comparable-price evidence.
 * Payment for promotion never feeds into this module.
 */

export const SCORING_VERSION = 'v1';
export const MIN_COMPARABLES = 5;
export const MAX_COMPARABLE_AGE_DAYS = 90;

export type Condition = 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR' | 'POOR' | 'FOR_PARTS' | 'UNKNOWN';
export type ScoringStatus =
  | 'ACTIVE'
  | 'POSSIBLY_EXPIRED'
  | 'REPORTED_UNAVAILABLE'
  | 'CONFIRMED_UNAVAILABLE'
  | 'REMOVED'
  | 'UNDER_REVIEW';
export type ScoringRisk = 'NO_MAJOR_SIGNALS' | 'EXERCISE_CAUTION' | 'UNDER_REVIEW';

export interface Comparable {
  id?: string;
  priceMinor: number;
  currency: string;
  countryCode: string;
  categoryKey: string;
  observedAt: Date;
}

export interface ScoringListing {
  id?: string;
  priceMinor: number | null;
  currency: string;
  countryCode: string;
  categoryKey: string;
  condition: Condition;
  status: ScoringStatus;
  risk: ScoringRisk;
  lastConfirmedAt: Date;
  /** Distinct users who reported the listing unavailable and whose reports are still open. */
  openUnavailableReports?: number;
}

export interface ComparableEvidence {
  eligible: boolean;
  sampleSize: number;
  medianMinor: number | null;
  lowMinor: number | null;
  highMinor: number | null;
  /** Why evidence is missing or limited, in plain language. */
  limitations: string[];
}

export interface DealScoreResult {
  /** null when a score cannot honestly be given. */
  score: number | null;
  version: string;
  factors: Record<string, { points: number; max: number; note: string }>;
  evidence: ComparableEvidence;
  explanation: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const HOUR = 3_600_000;

/** Keep only comparables that are genuinely comparable: same country, currency, category, recent, priced. */
export function selectComparables(listing: ScoringListing, comps: Comparable[], now: Date): Comparable[] {
  const currency = assertCurrency(listing.currency);
  const cutoff = now.getTime() - MAX_COMPARABLE_AGE_DAYS * 24 * HOUR;
  return comps.filter(
    (c) =>
      c.id !== listing.id &&
      c.priceMinor > 0 && // free items say nothing about market value
      c.currency.toUpperCase() === currency && // no FX conversion: never mix currencies
      c.countryCode === listing.countryCode &&
      c.categoryKey === listing.categoryKey &&
      c.observedAt.getTime() >= cutoff &&
      c.observedAt.getTime() <= now.getTime(),
  );
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : Math.round(sorted[base] + rest * (next - sorted[base]));
}

export function buildEvidence(listing: ScoringListing, comps: Comparable[], now: Date): ComparableEvidence {
  const eligibleComps = selectComparables(listing, comps, now);
  const limitations: string[] = [
    'Based on asking prices of comparable listings, not confirmed sale prices.',
  ];
  if (eligibleComps.length < MIN_COMPARABLES) {
    limitations.unshift(
      `Only ${eligibleComps.length} comparable listing${eligibleComps.length === 1 ? '' : 's'} found; at least ${MIN_COMPARABLES} are needed.`,
    );
    return {
      eligible: false,
      sampleSize: eligibleComps.length,
      medianMinor: null,
      lowMinor: null,
      highMinor: null,
      limitations,
    };
  }
  const prices = eligibleComps.map((c) => c.priceMinor).sort((a, b) => a - b);
  // Interquartile range trim guards against a single absurd listing skewing the range.
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const iqr = q3 - q1;
  const trimmed = prices.filter((p) => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  const use = trimmed.length >= MIN_COMPARABLES ? trimmed : prices;
  if (use.length < prices.length) limitations.push(`${prices.length - use.length} outlier price(s) excluded from the range.`);
  limitations.push(`Same country and currency, observed within the last ${MAX_COMPARABLE_AGE_DAYS} days.`);
  return {
    eligible: true,
    sampleSize: use.length,
    medianMinor: quantile(use, 0.5),
    lowMinor: use[0],
    highMinor: use[use.length - 1],
    limitations,
  };
}

const CONDITION_POINTS: Record<Condition, number> = {
  NEW: 15,
  LIKE_NEW: 14,
  GOOD: 11,
  FAIR: 7,
  POOR: 3,
  FOR_PARTS: 1,
  UNKNOWN: 5,
};

const RISK_POINTS: Record<ScoringRisk, number> = { NO_MAJOR_SIGNALS: 6, EXERCISE_CAUTION: 3, UNDER_REVIEW: 0 };

export interface ScoreOptions {
  /** Distance from the viewing user in km, when known. */
  distanceKm?: number | null;
  now?: Date;
}

export function scoreDeal(listing: ScoringListing, comps: Comparable[], options: ScoreOptions = {}): DealScoreResult {
  const now = options.now ?? new Date();
  const evidence = buildEvidence(listing, comps, now);
  const factors: DealScoreResult['factors'] = {};

  const none = (explanation: string): DealScoreResult => ({
    score: null,
    version: SCORING_VERSION,
    factors,
    evidence,
    explanation,
  });

  if (listing.status !== 'ACTIVE' && listing.status !== 'POSSIBLY_EXPIRED') {
    return none('No Deal Score: this listing is not currently available.');
  }
  if (listing.priceMinor === null) {
    return none('No Deal Score: the seller did not state a price.');
  }
  if (!evidence.eligible || evidence.medianMinor === null) {
    return none(`No Deal Score yet: ${evidence.limitations[0]}`);
  }

  // Price vs comparables (50): ratio <=0.2 of median earns full points, >=1.0 earns none.
  const ratio = listing.priceMinor / evidence.medianMinor;
  const pricePoints = Math.round(50 * clamp(1 - (ratio - 0.2) / 0.8, 0, 1));
  factors.price = {
    points: pricePoints,
    max: 50,
    note: `Asking ${(ratio * 100).toFixed(0)}% of the comparable median`,
  };

  const cond = CONDITION_POINTS[listing.condition];
  factors.condition = { points: cond, max: 15, note: `Condition: ${listing.condition.toLowerCase().replace('_', ' ')}` };

  // Freshness (15): based on the last positive availability evidence, not on page existence.
  const ageH = Math.max(0, (now.getTime() - listing.lastConfirmedAt.getTime()) / HOUR);
  const fresh = Math.round(15 * clamp(1 - (ageH - 6) / (168 - 6), 0, 1));
  factors.freshness = { points: fresh, max: 15, note: `Last confirmed ${Math.round(ageH)}h ago` };

  // Distance (8): neutral half-credit when unknown, so the stored base score is user-independent.
  const km = options.distanceKm;
  const dist = km === null || km === undefined ? 4 : Math.round(8 * clamp(1 - (km - 2) / 48, 0, 1));
  factors.distance = {
    points: dist,
    max: 8,
    note: km === null || km === undefined ? 'Distance unknown' : `${km.toFixed(1)} km away`,
  };

  const evid = evidence.sampleSize >= 20 ? 6 : evidence.sampleSize >= 10 ? 4 : 2;
  factors.evidence = { points: evid, max: 6, note: `${evidence.sampleSize} comparable listings` };

  const trust = RISK_POINTS[listing.risk];
  factors.trust = { points: trust, max: 6, note: `Risk signals: ${listing.risk.toLowerCase().replace(/_/g, ' ')}` };

  let total = pricePoints + cond + fresh + dist + evid + trust;

  const reports = listing.openUnavailableReports ?? 0;
  if (reports > 0) {
    const penalty = Math.min(15, reports * 5);
    factors.availabilityReports = { points: -penalty, max: 0, note: `${reports} unavailable report(s)` };
    total -= penalty;
  }
  if (listing.status === 'POSSIBLY_EXPIRED') total = Math.min(total, 50);

  const score = clamp(Math.round(total), 0, 100);
  const cur = listing.currency;
  const free = listing.priceMinor === 0;
  const priceText = free ? 'Listed free' : `Listed at ${formatMinor(listing.priceMinor, cur)}`;
  const explanation =
    `Deal Score: ${score}/100 — ${priceText} compared with ${evidence.sampleSize} comparable listings ` +
    `(median ${formatMinor(evidence.medianMinor, cur)}, range ${formatMinor(evidence.lowMinor!, cur)}–${formatMinor(evidence.highMinor!, cur)}).` +
    (listing.status === 'POSSIBLY_EXPIRED' ? ' This listing may no longer be available.' : '');

  return { score, version: SCORING_VERSION, factors, evidence, explanation };
}
