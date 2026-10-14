import { haversineKm } from './geo';
import { normalizeText } from './dedup';

/** Alert matching and delivery planning. Pure functions; persistence and push sending live elsewhere. */

export type AlertFrequency = 'IMMEDIATE' | 'HOURLY_DIGEST' | 'DAILY_DIGEST';

export interface AlertCriteria {
  active: boolean;
  keywords: string[]; // a listing matches if ANY keyword/phrase appears
  excludedWords: string[]; // a listing is rejected if ANY appears
  categories: string[];
  minPriceMinor?: number | null;
  maxPriceMinor?: number | null;
  currency?: string | null; // required for price bounds to apply
  freeOnly: boolean;
  radiusKm?: number | null;
  centerLat?: number | null;
  centerLng?: number | null;
  conditions: string[];
  minDealScore?: number | null;
  sourceKeys: string[];
}

export interface AlertCandidate {
  id: string;
  title: string;
  description: string;
  status: string;
  priceMinor: number | null;
  currency: string;
  isFree: boolean;
  categoryKey: string;
  condition: string;
  lat: number;
  lng: number;
  sourceKey: string;
  dealScore: number | null;
}

export interface MatchResult {
  match: boolean;
  /** First failing rule, for debugging and "why didn't this alert fire" explanations. */
  failed?: string;
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const p = normalizeText(phrase);
  if (!p) return false;
  return ` ${haystack} `.includes(` ${p} `);
}

export function matchesAlert(criteria: AlertCriteria, listing: AlertCandidate): MatchResult {
  const fail = (failed: string): MatchResult => ({ match: false, failed });
  if (!criteria.active) return fail('alert inactive');
  if (listing.status !== 'ACTIVE') return fail('listing not active');

  if (criteria.freeOnly && !(listing.isFree && listing.priceMinor === 0)) return fail('free only');

  const hasMin = criteria.minPriceMinor !== null && criteria.minPriceMinor !== undefined;
  const hasMax = criteria.maxPriceMinor !== null && criteria.maxPriceMinor !== undefined;
  if (hasMin || hasMax) {
    // A price bound needs a known price in the same currency. Unknown price never matches a bound.
    if (listing.priceMinor === null) return fail('price unknown');
    if (!criteria.currency || criteria.currency.toUpperCase() !== listing.currency.toUpperCase()) return fail('currency mismatch');
    if (hasMin && listing.priceMinor < (criteria.minPriceMinor as number)) return fail('below min price');
    if (hasMax && listing.priceMinor > (criteria.maxPriceMinor as number)) return fail('above max price');
  }

  if (criteria.categories.length > 0 && !criteria.categories.includes(listing.categoryKey)) return fail('category');
  if (criteria.conditions.length > 0 && !criteria.conditions.includes(listing.condition)) return fail('condition');
  if (criteria.sourceKeys.length > 0 && !criteria.sourceKeys.includes(listing.sourceKey)) return fail('source');

  const text = normalizeText(`${listing.title} ${listing.description}`);
  if (criteria.excludedWords.some((w) => containsPhrase(text, w))) return fail('excluded word');
  if (criteria.keywords.length > 0 && !criteria.keywords.some((w) => containsPhrase(text, w))) return fail('keywords');

  if (criteria.radiusKm !== null && criteria.radiusKm !== undefined) {
    if (criteria.centerLat == null || criteria.centerLng == null) return fail('radius without center');
    const d = haversineKm(criteria.centerLat, criteria.centerLng, listing.lat, listing.lng);
    if (d > criteria.radiusKm) return fail('outside radius');
  }

  if (criteria.minDealScore !== null && criteria.minDealScore !== undefined) {
    if (listing.dealScore === null || listing.dealScore < criteria.minDealScore) return fail('deal score');
  }
  return { match: true };
}

/** Matches the DB unique constraint on (subscriptionId, listingId): one alert per listing per subscription. */
export function dedupKey(subscriptionId: string, listingId: string): string {
  return `${subscriptionId}:${listingId}`;
}

export interface DeliveryContext {
  frequency: AlertFrequency;
  now: Date;
  timeZone: string;
  pushEnabled: boolean;
  quietHoursStart?: number | null; // local hour 0-23
  quietHoursEnd?: number | null;
  sentLast24h: number;
  maxPerDay: number;
  lastDigestAt?: Date | null;
}

export type DeliveryDecision =
  | { action: 'SEND_NOW' }
  | { action: 'QUEUE_DIGEST'; dueAt: Date }
  | { action: 'DEFER_QUIET_HOURS' }
  | { action: 'SKIP'; reason: 'PUSH_DISABLED' | 'DAILY_LIMIT' };

export function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).formatToParts(now);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(h) % 24;
}

export function inQuietHours(hour: number, start?: number | null, end?: number | null): boolean {
  if (start == null || end == null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end; // wraps midnight
}

export function planDelivery(ctx: DeliveryContext): DeliveryDecision {
  if (!ctx.pushEnabled) return { action: 'SKIP', reason: 'PUSH_DISABLED' };
  if (ctx.sentLast24h >= ctx.maxPerDay) return { action: 'SKIP', reason: 'DAILY_LIMIT' };

  if (ctx.frequency === 'IMMEDIATE') {
    if (inQuietHours(localHour(ctx.now, ctx.timeZone), ctx.quietHoursStart, ctx.quietHoursEnd)) {
      return { action: 'DEFER_QUIET_HOURS' };
    }
    return { action: 'SEND_NOW' };
  }
  const interval = ctx.frequency === 'HOURLY_DIGEST' ? 3_600_000 : 86_400_000;
  const base = ctx.lastDigestAt ? ctx.lastDigestAt.getTime() : ctx.now.getTime();
  return { action: 'QUEUE_DIGEST', dueAt: new Date(Math.max(base + interval, ctx.now.getTime())) };
}

export function isDigestDue(frequency: AlertFrequency, now: Date, lastDigestAt?: Date | null): boolean {
  if (frequency === 'IMMEDIATE') return false;
  if (!lastDigestAt) return true;
  const interval = frequency === 'HOURLY_DIGEST' ? 3_600_000 : 86_400_000;
  return now.getTime() - lastDigestAt.getTime() >= interval;
}
