import { FeedItemError, JsonFeedProvider, parseFeedItem } from './json-feed';
import { ProviderPermanentError, ProviderRateLimitError, ProviderTransientError } from './provider';

const CATS = ['furniture', 'electronics', 'other'];
const good = () => ({ id: 'a1', title: 'Oak desk', url: 'https://partner.example/items/a1', location: { lat: 51.5, lng: -0.12, country: 'gb' }, price: { amount: '12.50', currency: 'GBP' }, category: 'furniture', condition: 'good', images: ['https://img.example/1.jpg'], posted_at: '2026-10-01T10:00:00Z', available: true });

describe('parseFeedItem', () => {
  it('reads a complete item', () => {
    const i = parseFeedItem(good(), CATS);
    expect(i).toMatchObject({ externalId: 'a1', title: 'Oak desk', priceMinor: 1250, currency: 'GBP', categoryKey: 'furniture', condition: 'GOOD', countryCode: 'GB', available: true });
    expect(i.postedAt).toEqual(new Date('2026-10-01T10:00:00Z'));
  });
  it('keeps an unknown price unknown, and only an explicit zero is free', () => {
    const { price, ...rest } = good();
    expect(parseFeedItem(rest, CATS).priceMinor).toBeNull();
    expect(parseFeedItem({ ...rest, price: null }, CATS).priceMinor).toBeNull();
    expect(parseFeedItem({ ...rest, price: { amount: '0.00', currency: 'GBP' } }, CATS).priceMinor).toBe(0);
  });
  it.each([
    ['no id', { id: undefined }],
    ['empty title', { title: '  ' }],
    ['http url', { url: 'http://partner.example/x' }],
    ['not a url', { url: 'nope' }],
    ['no location', { location: undefined }],
    ['out-of-range coordinates', { location: { lat: 95, lng: 0, country: 'GB' } }],
    ['string coordinates', { location: { lat: '51.5', lng: '0', country: 'GB' } }],
    ['bad country', { location: { lat: 1, lng: 1, country: 'GBR' } }],
    ['numeric price amount', { price: { amount: 12.5, currency: 'GBP' } }],
    ['negative price', { price: { amount: '-1', currency: 'GBP' } }],
    ['unknown currency', { price: { amount: '1', currency: 'XXX' } }],
    ['bad date', { posted_at: 'yesterday' }],
    ['available as a string', { available: 'yes' }],
  ])('rejects %s', (_n, patch) => {
    expect(() => parseFeedItem({ ...good(), ...patch }, CATS)).toThrow(FeedItemError);
  });
  it('drops non-https images, falls back to "other" and UNKNOWN', () => {
    const i = parseFeedItem({ ...good(), images: ['http://x/1.jpg', 'https://x/2.jpg'], category: 'spaceships', condition: 'shiny' }, CATS);
    expect(i.imageUrls).toEqual(['https://x/2.jpg']);
    expect(i.categoryKey).toBe('other');
    expect(i.condition).toBe('UNKNOWN');
  });
});

describe('JsonFeedProvider HTTP handling', () => {
  const make = (res: (u: URL, init: RequestInit) => Promise<Response>, apiKey: string | null = 'k') =>
    new JsonFeedProvider({ key: 'p', name: 'Partner', url: 'https://partner.example/feed', apiKey, countries: ['GB'], categories: CATS, fetchImpl: res as unknown as typeof fetch });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers }));
  const ask = (p: JsonFeedProvider) => p.fetchListings({ countryCode: 'GB', limit: 1 });

  it('is not configured without a key and limits countries', () => {
    const p = make(json({}), null);
    expect(p.isConfigured()).toBe(false);
    expect(p.setupInstructions()).toContain('PARTNER_FEED_P_API_KEY');
    expect(p.supportsCountry('gb')).toBe(true);
    expect(p.supportsCountry('US')).toBe(false);
  });
  it('sends the key, country, limit and cursor', async () => {
    let seen: { url: string; auth: string } | undefined;
    const p = make(async (u, init) => { seen = { url: u.toString(), auth: (init.headers as Record<string, string>).authorization }; return new Response(JSON.stringify({ items: [], next_cursor: null })); });
    await p.fetchListings({ countryCode: 'GB', limit: 50, cursor: 'abc' });
    expect(seen!.url).toBe('https://partner.example/feed?country=GB&limit=50&cursor=abc');
    expect(seen!.auth).toBe('Bearer k');
  });
  it('counts rejected items instead of hiding them', async () => {
    const page = await ask(make(json({ items: [good(), { id: 'bad' }], next_cursor: 'n2' })));
    expect(page.items).toHaveLength(1);
    expect(page.rejected).toBe(1);
    expect(page.nextCursor).toBe('n2');
  });
  it('classifies failures', async () => {
    await expect(ask(make(json({}, 429, { 'retry-after': '3' })))).rejects.toMatchObject({ retryAfterMs: 3000 });
    await expect(ask(make(json({}, 429)))).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(ask(make(json({}, 503)))).rejects.toBeInstanceOf(ProviderTransientError);
    await expect(ask(make(json({}, 401)))).rejects.toBeInstanceOf(ProviderPermanentError);
    await expect(ask(make(json({}, 404)))).rejects.toBeInstanceOf(ProviderPermanentError);
    await expect(ask(make(json({ nothing: true })))).rejects.toBeInstanceOf(ProviderPermanentError);
    await expect(ask(make(() => Promise.resolve(new Response('<html>', { status: 200 }))))).rejects.toBeInstanceOf(ProviderTransientError);
    await expect(ask(make(() => Promise.reject(new Error('ECONNRESET'))))).rejects.toBeInstanceOf(ProviderTransientError);
  });
});
