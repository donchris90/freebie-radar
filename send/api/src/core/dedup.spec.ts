import { canonicalizeUrl, compareListings, contentHash, DedupListing, findDuplicates, normalizeText, tokens } from './dedup';

const base: DedupListing = {
  id: 'a',
  sourceId: 's1',
  externalId: 'x1',
  canonicalUrl: null,
  title: 'IKEA Kallax shelf unit, white',
  description: 'Good condition, 4x2. Collection only.',
  priceMinor: 3000,
  currency: 'USD',
  lat: 40.7128,
  lng: -74.006,
  sellerUserId: 'u1',
};
const other = (over: Partial<DedupListing>): DedupListing => ({ ...base, id: 'b', externalId: 'x2', ...over });

describe('text normalisation', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(normalizeText('  Café  TABLE!! ')).toBe('cafe table');
  });
  it('drops stopwords and single characters from tokens', () => {
    expect(tokens('The big a table for free')).toEqual(['big', 'table']);
  });
  it('hashes equivalent text identically', () => {
    expect(contentHash('Sofa!', 'Nice  sofa.')).toBe(contentHash('sofa', 'nice sofa'));
    expect(contentHash('Sofa', 'x')).not.toBe(contentHash('Sofa', 'y'));
  });
});

describe('canonicalizeUrl', () => {
  it('removes tracking params, fragments, www and trailing slashes', () => {
    expect(canonicalizeUrl('https://www.Example.com/item/123/?utm_source=x&b=2&a=1#top')).toBe('example.com/item/123?a=1&b=2');
  });
  it('rejects non-http schemes and garbage', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });
});

describe('compareListings', () => {
  it('flags the same source id as exact', () => {
    expect(compareListings(base, other({ externalId: 'x1' })).kind).toBe('exact');
  });
  it('flags the same canonical URL as strong', () => {
    const v = compareListings({ ...base, canonicalUrl: 'ex.com/1' }, other({ sourceId: 's2', canonicalUrl: 'ex.com/1' }));
    expect(v.kind).toBe('strong');
  });
  it('flags identical text, price and nearby location as strong', () => {
    expect(compareListings(base, other({ sourceId: 's2', lat: 40.7135 })).kind).toBe('strong');
  });
  it('treats similar title, same area and similar price as a review candidate only', () => {
    const v = compareListings(base, other({ sourceId: 's2', title: 'Ikea Kallax shelf unit white', description: 'different words', priceMinor: 3100 }));
    expect(v.kind).toBe('candidate');
  });
  it('does not flag different prices, far locations or different currencies', () => {
    const similar = { title: 'Ikea Kallax shelf unit white', description: 'z', sourceId: 's2' };
    expect(compareListings(base, other({ ...similar, priceMinor: 9000 })).kind).toBe('none');
    expect(compareListings(base, other({ ...similar, lat: 41.5 })).kind).toBe('none');
    expect(compareListings(base, other({ ...similar, currency: 'GBP' })).kind).toBe('none');
  });
  it('handles two free listings and missing prices', () => {
    const similar = { title: 'Ikea Kallax shelf unit white', description: 'z', sourceId: 's2' };
    expect(compareListings({ ...base, priceMinor: 0 }, other({ ...similar, priceMinor: 0 })).kind).toBe('candidate');
    expect(compareListings(base, other({ ...similar, priceMinor: null })).kind).toBe('candidate');
  });
  it('never compares a record with itself', () => {
    expect(compareListings(base, base).kind).toBe('none');
  });
});

describe('findDuplicates', () => {
  it('separates auto-linkable matches from review candidates', () => {
    const strong = other({ id: 'c', sourceId: 's2', lat: 40.7135 });
    const cand = other({ id: 'd', sourceId: 's3', title: 'Ikea Kallax shelf unit white', description: 'q', priceMinor: 3100 });
    const far = other({ id: 'e', sourceId: 's4', lat: 10, lng: 10 });
    const r = findDuplicates(base, [cand, far, strong]);
    expect(r.autoLinkable?.listing.id).toBe('c');
    expect(r.reviewCandidates.map((x) => x.listing.id)).toEqual(['d']);
  });
});
