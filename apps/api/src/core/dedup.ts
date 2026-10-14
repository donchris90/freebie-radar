import { createHash } from 'crypto';
import { haversineKm } from './geo';

/**
 * Duplicate detection. Exact/strong matches are safe to link automatically; "candidate" matches only
 * go to a review queue and are never merged without a human or a deterministic strong signal.
 */

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'in', 'on', 'of', 'to', 'with', 'is', 'my', 'free', 'sale']);

export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(input: string): string[] {
  return normalizeText(input)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function contentHash(title: string, description: string): string {
  const body = `${normalizeText(title)}|${normalizeText(description).slice(0, 500)}`;
  return createHash('sha256').update(body).digest('hex');
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|ref$|ref_src$|mc_)/i;

/** Normalises a URL for comparison. Returns null for non-http(s) or unparsable input. */
export function canonicalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/+$/, '');
  if (path === '') path = '/';
  const query = u.search;
  return `${u.hostname}${path}${query}`;
}

export interface DedupListing {
  id: string;
  sourceId: string;
  externalId?: string | null;
  canonicalUrl?: string | null;
  title: string;
  description: string;
  priceMinor: number | null;
  currency: string;
  lat: number;
  lng: number;
  sellerUserId?: string | null;
}

export type DuplicateKind = 'exact' | 'strong' | 'candidate' | 'none';
export interface DuplicateVerdict {
  kind: DuplicateKind;
  reasons: string[];
}

export const CANDIDATE_TITLE_SIMILARITY = 0.8;
export const CANDIDATE_MAX_DISTANCE_KM = 2;
export const CANDIDATE_PRICE_TOLERANCE = 0.1;

export function compareListings(a: DedupListing, b: DedupListing): DuplicateVerdict {
  if (a.id === b.id) return { kind: 'none', reasons: ['same record'] };

  if (a.sourceId === b.sourceId && a.externalId && a.externalId === b.externalId) {
    return { kind: 'exact', reasons: ['same source and source listing id'] };
  }
  if (a.canonicalUrl && b.canonicalUrl && a.canonicalUrl === b.canonicalUrl) {
    return { kind: 'strong', reasons: ['same canonical URL'] };
  }

  const distance = haversineKm(a.lat, a.lng, b.lat, b.lng);
  const sameHash = contentHash(a.title, a.description) === contentHash(b.title, b.description);
  if (sameHash && distance <= CANDIDATE_MAX_DISTANCE_KM && a.currency === b.currency && a.priceMinor === b.priceMinor) {
    return { kind: 'strong', reasons: ['identical text, price and nearby location'] };
  }

  const reasons: string[] = [];
  const sim = jaccard(tokens(a.title), tokens(b.title));
  if (sim >= CANDIDATE_TITLE_SIMILARITY) reasons.push(`title similarity ${(sim * 100).toFixed(0)}%`);
  else return { kind: 'none', reasons: [] };

  if (distance > CANDIDATE_MAX_DISTANCE_KM) return { kind: 'none', reasons: [] };
  reasons.push(`${distance.toFixed(1)} km apart`);

  if (a.currency !== b.currency) return { kind: 'none', reasons: [] };
  if (a.priceMinor === null || b.priceMinor === null) {
    reasons.push('price missing on one listing');
  } else if (a.priceMinor === 0 && b.priceMinor === 0) {
    reasons.push('both free');
  } else {
    const hi = Math.max(a.priceMinor, b.priceMinor);
    const diff = Math.abs(a.priceMinor - b.priceMinor) / hi;
    if (diff > CANDIDATE_PRICE_TOLERANCE) return { kind: 'none', reasons: [] };
    reasons.push(`prices within ${(CANDIDATE_PRICE_TOLERANCE * 100).toFixed(0)}%`);
  }
  return { kind: 'candidate', reasons };
}

/** Finds the strongest duplicate of `incoming` among `existing`. Candidates are returned for review only. */
export function findDuplicates(incoming: DedupListing, existing: DedupListing[]) {
  const rank: Record<DuplicateKind, number> = { exact: 3, strong: 2, candidate: 1, none: 0 };
  const results = existing
    .map((e) => ({ listing: e, verdict: compareListings(incoming, e) }))
    .filter((r) => r.verdict.kind !== 'none')
    .sort((x, y) => rank[y.verdict.kind] - rank[x.verdict.kind]);
  return {
    autoLinkable: results.find((r) => r.verdict.kind === 'exact' || r.verdict.kind === 'strong') ?? null,
    reviewCandidates: results.filter((r) => r.verdict.kind === 'candidate'),
  };
}

/** Number of listings sharing a content hash, used as a (weak) scam-risk signal. */
export function repeatedContentCount(hashes: string[], hash: string): number {
  return hashes.filter((h) => h === hash).length;
}
