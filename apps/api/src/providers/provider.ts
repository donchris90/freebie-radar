/**
 * Provider-adapter framework. Each authorised listing source is integrated independently by
 * implementing ListingProvider. Providers declare the capabilities they ACTUALLY offer; callers must
 * never assume a capability that is not declared. Unconfigured providers report a setup state and
 * never return fabricated data.
 */

export interface ProviderCapabilities {
  pagination: boolean;
  price: boolean;
  images: boolean;
  approximateLocation: boolean;
  category: boolean;
  lastUpdated: boolean;
  availabilityStatus: boolean;
  recheck: boolean;
}

export interface NormalizedListing {
  externalId: string;
  title: string;
  description?: string;
  /** null = price not provided by the source (NOT free). */
  priceMinor?: number | null;
  currency?: string;
  categoryKey?: string;
  condition?: string;
  url?: string;
  imageUrls?: string[];
  lat?: number;
  lng?: number;
  countryCode?: string;
  postedAt?: Date;
  updatedAt?: Date;
  available?: boolean;
}

export interface FetchParams {
  cursor?: string | null;
  limit: number;
  countryCode: string;
  updatedSince?: Date;
}

export interface ProviderPage {
  items: NormalizedListing[];
  nextCursor: string | null;
  /** Items the source sent that failed validation and were left out. */
  rejected?: number;
}

export interface ListingProvider {
  readonly key: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** True only when every required credential/approval is present. */
  isConfigured(): boolean;
  /** Human-readable setup instructions shown when not configured. */
  setupInstructions(): string;
  supportsCountry(countryCode: string): boolean;
  fetchListings(params: FetchParams): Promise<ProviderPage>;
  /** Only present when capabilities.recheck is true and the source's terms permit it. */
  recheck?(externalId: string): Promise<{ available: boolean }>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(public readonly providerKey: string) {
    super(`Provider "${providerKey}" is not configured`);
  }
}
export class ProviderRateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super('Provider rate limit reached');
  }
}
export class ProviderTransientError extends Error {}
export class ProviderPermanentError extends Error {}

export interface BackoffOptions {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface AttemptResult<T> {
  ok: boolean;
  value?: T;
  attempts: number;
  error?: Error;
  /** Failure classification for admin reporting. */
  failure?: 'NOT_CONFIGURED' | 'RATE_LIMITED' | 'TRANSIENT_EXHAUSTED' | 'PERMANENT';
}

/**
 * Bounded exponential backoff with jitter. Retries rate limits (honouring Retry-After, capped at
 * maxMs) and transient failures. Never retries permanent or not-configured errors.
 */
export async function runWithBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<AttemptResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let lastError: Error | undefined;
  let lastKind: AttemptResult<T>['failure'];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { ok: true, value: await fn(), attempts: attempt };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      lastError = err;
      if (err instanceof ProviderNotConfiguredError) return { ok: false, attempts: attempt, error: err, failure: 'NOT_CONFIGURED' };
      if (err instanceof ProviderPermanentError) return { ok: false, attempts: attempt, error: err, failure: 'PERMANENT' };
      const isRate = err instanceof ProviderRateLimitError;
      if (!isRate && !(err instanceof ProviderTransientError)) {
        // Unknown errors are treated as permanent: we do not hammer a source on bugs.
        return { ok: false, attempts: attempt, error: err, failure: 'PERMANENT' };
      }
      lastKind = isRate ? 'RATE_LIMITED' : 'TRANSIENT_EXHAUSTED';
      if (attempt === maxAttempts) break;
      const expo = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jittered = Math.round(expo * (0.5 + random() * 0.5));
      const wait = isRate && (err as ProviderRateLimitError).retryAfterMs !== undefined
        ? Math.min(maxMs, (err as ProviderRateLimitError).retryAfterMs as number)
        : jittered;
      await sleep(wait);
    }
  }
  return { ok: false, attempts: maxAttempts, error: lastError, failure: lastKind };
}

export type SyncState = 'OK' | 'NOT_CONFIGURED' | 'COUNTRY_UNSUPPORTED' | 'RATE_LIMITED' | 'FAILED';

export interface SyncOutcome {
  state: SyncState;
  items: NormalizedListing[];
  attempts: number;
  message?: string;
  rejected?: number;
}

/** Fetches one page, converting every failure mode into an explicit state. Never returns fake items. */
export async function fetchPageSafely(
  provider: ListingProvider,
  params: FetchParams,
  opts?: BackoffOptions,
): Promise<SyncOutcome & { nextCursor?: string | null }> {
  if (!provider.isConfigured()) {
    return { state: 'NOT_CONFIGURED', items: [], attempts: 0, message: provider.setupInstructions() };
  }
  if (!provider.supportsCountry(params.countryCode)) {
    return { state: 'COUNTRY_UNSUPPORTED', items: [], attempts: 0, message: `${provider.name} is not available in ${params.countryCode}` };
  }
  const r = await runWithBackoff(() => provider.fetchListings(params), opts);
  if (r.ok && r.value) return { state: 'OK', items: r.value.items, nextCursor: r.value.nextCursor, attempts: r.attempts, rejected: r.value.rejected ?? 0 };
  const state: SyncState = r.failure === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : r.failure === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'FAILED';
  return { state, items: [], attempts: r.attempts, message: r.error?.message };
}
