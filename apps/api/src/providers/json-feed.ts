import { CONDITIONS, Condition } from '../domain/models';
import { assertCurrency, MoneyError, parseMajorToMinor } from '../core/money';
import { isValidCoordinate } from '../core/geo';
import {
  FetchParams,
  ListingProvider,
  NormalizedListing,
  ProviderCapabilities,
  ProviderNotConfiguredError,
  ProviderPage,
  ProviderPermanentError,
  ProviderRateLimitError,
  ProviderTransientError,
} from './provider';

/**
 * Reader for the Freebie Radar partner-feed contract (docs/LISTING_SOURCES.md). A partner that has agreed
 * in writing to supply listings exposes one HTTPS endpoint; this class reads it and nothing else. It never
 * scrapes pages, never guesses a field, and drops (and counts) any item that does not meet the contract.
 *
 *   GET {url}?country=GB&limit=100&cursor=...        Authorization: Bearer <key>
 *   200 { "items": [ { "id", "title", "url", "location": {"lat","lng","country"}, ... } ], "next_cursor": "..." | null }
 *   429 + Retry-After, 5xx and network errors are retried; other 4xx are permanent.
 */

export interface JsonFeedOptions {
  key: string;
  name: string;
  url: string;
  apiKey: string | null;
  /** Countries the partner serves. Empty = any country asked for. */
  countries: string[];
  categories: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Largest response body accepted, in bytes. */
  maxBytes?: number;
}

const CAPS: ProviderCapabilities = {
  pagination: true,
  price: true,
  images: true,
  approximateLocation: true,
  category: true,
  lastUpdated: true,
  availabilityStatus: true,
  recheck: false,
};

const DECIMAL = /^\d{1,9}(\.\d{1,4})?$/;

export class FeedItemError extends Error {}

/** Validates one raw feed item. Throws FeedItemError with a reason; never repairs or invents data. */
export function parseFeedItem(raw: unknown, categories: string[]): NormalizedListing {
  if (!raw || typeof raw !== 'object') throw new FeedItemError('item is not an object');
  const r = raw as Record<string, any>;
  const str = (v: unknown, name: string, max: number, required = true): string | undefined => {
    if (v === undefined || v === null || v === '') {
      if (required) throw new FeedItemError(`${name} is missing`);
      return undefined;
    }
    if (typeof v !== 'string') throw new FeedItemError(`${name} must be a string`);
    const t = v.trim();
    if (!t && required) throw new FeedItemError(`${name} is empty`);
    if (t.length > max) throw new FeedItemError(`${name} is too long`);
    return t || undefined;
  };

  const externalId = str(r.id, 'id', 200)!;
  const title = str(r.title, 'title', 200)!;
  const description = str(r.description, 'description', 5000, false);

  const url = str(r.url, 'url', 2000)!;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new FeedItemError('url is not a valid URL'); }
  if (parsed.protocol !== 'https:') throw new FeedItemError('url must be https');

  const loc = r.location;
  if (!loc || typeof loc !== 'object') throw new FeedItemError('location is missing');
  if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number' || !isValidCoordinate(loc.lat, loc.lng)) throw new FeedItemError('location has no valid lat/lng');
  const country = str(loc.country, 'location.country', 2)!.toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new FeedItemError('location.country must be a 2-letter code');

  let priceMinor: number | null = null;
  let currency: string | undefined;
  if (r.price !== undefined && r.price !== null) {
    if (typeof r.price !== 'object') throw new FeedItemError('price must be an object');
    const amount = r.price.amount;
    if (typeof amount !== 'string' || !DECIMAL.test(amount)) throw new FeedItemError('price.amount must be a decimal string such as "12.50"');
    try {
      currency = assertCurrency(String(r.price.currency ?? ''));
      priceMinor = parseMajorToMinor(amount, currency);
    } catch (e) {
      if (e instanceof MoneyError) throw new FeedItemError(`price: ${e.message}`);
      throw e;
    }
  }

  const images: string[] = [];
  if (r.images !== undefined && r.images !== null) {
    if (!Array.isArray(r.images)) throw new FeedItemError('images must be a list');
    for (const img of r.images.slice(0, 8)) {
      if (typeof img === 'string' && /^https:\/\//i.test(img) && img.length <= 2000) images.push(img);
    }
  }

  const cat = typeof r.category === 'string' ? r.category.trim().toLowerCase() : '';
  const categoryKey = categories.includes(cat) ? cat : categories.includes('other') ? 'other' : categories[0];
  const cond = typeof r.condition === 'string' ? (r.condition.trim().toUpperCase() as Condition) : 'UNKNOWN';

  const date = (v: unknown, name: string): Date | undefined => {
    if (v === undefined || v === null) return undefined;
    const d = typeof v === 'string' ? new Date(v) : new Date(NaN);
    if (Number.isNaN(d.getTime())) throw new FeedItemError(`${name} is not an ISO date`);
    return d;
  };
  if (r.available !== undefined && typeof r.available !== 'boolean') throw new FeedItemError('available must be true or false');

  return {
    externalId,
    title,
    description,
    priceMinor,
    currency,
    categoryKey,
    condition: CONDITIONS.includes(cond) ? cond : 'UNKNOWN',
    url: parsed.toString(),
    imageUrls: images,
    lat: loc.lat,
    lng: loc.lng,
    countryCode: country,
    postedAt: date(r.posted_at, 'posted_at'),
    updatedAt: date(r.updated_at, 'updated_at'),
    available: r.available ?? true,
  };
}

export class JsonFeedProvider implements ListingProvider {
  readonly key: string;
  readonly name: string;
  readonly capabilities = CAPS;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: JsonFeedOptions) {
    this.key = o.key;
    this.name = o.name;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  isConfigured() {
    return !!this.o.url && !!this.o.apiKey;
  }

  setupInstructions() {
    return `Set PARTNER_FEED_${this.key.toUpperCase().replace(/-/g, '_')}_API_KEY to the key ${this.name} issued to you. Do not enable this source until the written permission is on file (see docs/LISTING_SOURCES.md).`;
  }

  supportsCountry(code: string) {
    return this.o.countries.length === 0 || this.o.countries.includes(code.toUpperCase());
  }

  async fetchListings(p: FetchParams): Promise<ProviderPage> {
    if (!this.isConfigured()) throw new ProviderNotConfiguredError(this.key);
    const u = new URL(this.o.url);
    u.searchParams.set('country', p.countryCode);
    u.searchParams.set('limit', String(p.limit));
    if (p.cursor) u.searchParams.set('cursor', p.cursor);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.fetchImpl(u, { headers: { authorization: `Bearer ${this.o.apiKey}`, accept: 'application/json', 'user-agent': 'FreebieRadar-Sync/1.0' }, signal: ctl.signal, redirect: 'error' });
    } catch (e) {
      throw new ProviderTransientError(`${this.name}: ${ctl.signal.aborted ? 'request timed out' : 'network error'}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new ProviderRateLimitError(Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    if (res.status >= 500) throw new ProviderTransientError(`${this.name} answered ${res.status}`);
    if (res.status === 401 || res.status === 403) throw new ProviderPermanentError(`${this.name} refused our key (${res.status}). Check the key and that the agreement is still active.`);
    if (!res.ok) throw new ProviderPermanentError(`${this.name} answered ${res.status}`);

    const text = await res.text();
    if (text.length > (this.o.maxBytes ?? 5_000_000)) throw new ProviderPermanentError(`${this.name} sent a response larger than we accept`);
    let body: any;
    try { body = JSON.parse(text); } catch { throw new ProviderTransientError(`${this.name} sent something that is not JSON`); }
    if (!body || !Array.isArray(body.items)) throw new ProviderPermanentError(`${this.name} response has no "items" list`);
    if (body.next_cursor !== undefined && body.next_cursor !== null && typeof body.next_cursor !== 'string') throw new ProviderPermanentError('next_cursor must be a string or null');

    const items: NormalizedListing[] = [];
    let rejected = 0;
    for (const raw of body.items) {
      try { items.push(parseFeedItem(raw, this.o.categories)); } catch (e) { if (e instanceof FeedItemError) rejected++; else throw e; }
    }
    return { items, nextCursor: body.next_cursor ?? null, rejected };
  }
}
