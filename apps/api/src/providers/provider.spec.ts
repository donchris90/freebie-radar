import {
  fetchPageSafely,
  ListingProvider,
  ProviderNotConfiguredError,
  ProviderPermanentError,
  ProviderRateLimitError,
  ProviderTransientError,
  runWithBackoff,
} from './provider';

const noSleep = jest.fn(async (_ms: number) => undefined);
const fixedRandom = () => 1; // jitter factor 1.0

beforeEach(() => noSleep.mockClear());

describe('runWithBackoff', () => {
  it('returns immediately on success', async () => {
    const r = await runWithBackoff(async () => 'ok', { sleep: noSleep });
    expect(r).toMatchObject({ ok: true, value: 'ok', attempts: 1 });
    expect(noSleep).not.toHaveBeenCalled();
  });

  it('retries transient failures with bounded exponential backoff, then succeeds', async () => {
    let n = 0;
    const r = await runWithBackoff(
      async () => {
        if (++n < 3) throw new ProviderTransientError('boom');
        return 'done';
      },
      { baseMs: 100, maxMs: 1000, sleep: noSleep, random: fixedRandom },
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('gives up after maxAttempts and classifies the failure', async () => {
    const r = await runWithBackoff(async () => { throw new ProviderTransientError('down'); }, { maxAttempts: 3, sleep: noSleep });
    expect(r).toMatchObject({ ok: false, attempts: 3, failure: 'TRANSIENT_EXHAUSTED' });
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it('caps the delay at maxMs', async () => {
    await runWithBackoff(async () => { throw new ProviderTransientError('x'); }, { maxAttempts: 6, baseMs: 1000, maxMs: 2500, sleep: noSleep, random: fixedRandom });
    expect(Math.max(...noSleep.mock.calls.map((c) => c[0]))).toBeLessThanOrEqual(2500);
  });

  it('honours Retry-After on rate limits but never beyond maxMs', async () => {
    let n = 0;
    await runWithBackoff(
      async () => {
        if (++n < 2) throw new ProviderRateLimitError(5000);
        return 1;
      },
      { maxMs: 3000, sleep: noSleep },
    );
    expect(noSleep).toHaveBeenCalledWith(3000);
  });

  it('classifies persistent rate limiting', async () => {
    const r = await runWithBackoff(async () => { throw new ProviderRateLimitError(); }, { maxAttempts: 2, sleep: noSleep });
    expect(r.failure).toBe('RATE_LIMITED');
  });

  it('does not retry permanent, not-configured or unknown errors', async () => {
    for (const [err, failure] of [
      [new ProviderPermanentError('bad request'), 'PERMANENT'],
      [new ProviderNotConfiguredError('x'), 'NOT_CONFIGURED'],
      [new Error('bug'), 'PERMANENT'],
    ] as const) {
      const fn = jest.fn(async () => { throw err; });
      const r = await runWithBackoff(fn, { sleep: noSleep });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(r.failure).toBe(failure);
    }
  });
});

const makeProvider = (over: Partial<ListingProvider> = {}): ListingProvider => ({
  key: 'test',
  name: 'Test Source',
  capabilities: { pagination: true, price: true, images: false, approximateLocation: true, category: false, lastUpdated: true, availabilityStatus: false, recheck: false },
  isConfigured: () => true,
  setupInstructions: () => 'Set TEST_API_KEY after approval from Test Source.',
  supportsCountry: (c) => c === 'US',
  fetchListings: async () => ({ items: [{ externalId: '1', title: 'Chair' }], nextCursor: null }),
  ...over,
});

describe('fetchPageSafely', () => {
  const params = { limit: 10, countryCode: 'US' };

  it('returns real items when configured', async () => {
    const r = await fetchPageSafely(makeProvider(), params, { sleep: noSleep });
    expect(r.state).toBe('OK');
    expect(r.items).toHaveLength(1);
  });

  it('returns a setup state, not fake results, when credentials are missing', async () => {
    const fetchListings = jest.fn();
    const r = await fetchPageSafely(makeProvider({ isConfigured: () => false, fetchListings }), params);
    expect(r.state).toBe('NOT_CONFIGURED');
    expect(r.items).toEqual([]);
    expect(r.message).toMatch(/TEST_API_KEY/);
    expect(fetchListings).not.toHaveBeenCalled();
  });

  it('reports unsupported countries without calling the source', async () => {
    const fetchListings = jest.fn();
    const r = await fetchPageSafely(makeProvider({ fetchListings }), { ...params, countryCode: 'GB' });
    expect(r.state).toBe('COUNTRY_UNSUPPORTED');
    expect(fetchListings).not.toHaveBeenCalled();
  });

  it('surfaces rate limiting and outages as explicit states with no items', async () => {
    const limited = await fetchPageSafely(makeProvider({ fetchListings: async () => { throw new ProviderRateLimitError(1); } }), params, { maxAttempts: 2, sleep: noSleep });
    expect(limited).toMatchObject({ state: 'RATE_LIMITED', items: [] });
    const down = await fetchPageSafely(makeProvider({ fetchListings: async () => { throw new ProviderTransientError('503'); } }), params, { maxAttempts: 2, sleep: noSleep });
    expect(down).toMatchObject({ state: 'FAILED', items: [] });
  });
});
