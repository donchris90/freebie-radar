import './env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { REPOS, Repos } from '../src/domain/ports';
import { JobsService } from '../src/jobs/jobs.service';
import { configureApp } from '../src/main';
import { JsonFeedProvider } from '../src/providers/json-feed';
import { RegisteredSource, SOURCES, SyncService } from '../src/sync/sync.service';

/** A stand-in for a partner's feed: a real HTTP server whose behaviour each test controls. */
interface Fixture {
  items: Record<string, any[]>; // by country
  pageSize: number;
  key: string;
  hits: { country: string; cursor: string | null; auth: string | undefined }[];
  /** Responses to send before behaving normally, e.g. [429, 503]. */
  script: { status: number; retryAfter?: number }[];
  failOnPage?: number;
}
const fx: Fixture = { items: {}, pageSize: 2, key: 'secret-key', hits: [], script: [] };

function feedServer(): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url!, 'http://x');
      const country = u.searchParams.get('country')!;
      const cursor = u.searchParams.get('cursor');
      fx.hits.push({ country, cursor, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${fx.key}`) { res.writeHead(401).end(); return; }
      const scripted = fx.script.shift();
      if (scripted) { res.writeHead(scripted.status, scripted.retryAfter ? { 'retry-after': String(scripted.retryAfter) } : {}).end(); return; }
      const all = fx.items[country] ?? [];
      const start = cursor ? Number(cursor) : 0;
      if (fx.failOnPage !== undefined && start / fx.pageSize === fx.failOnPage) { res.writeHead(500).end(); return; }
      const slice = all.slice(start, start + fx.pageSize);
      const next = start + fx.pageSize < all.length ? String(start + fx.pageSize) : null;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: slice, next_cursor: next }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const item = (id: string, over: Record<string, any> = {}) => ({
  id, title: `Item ${id}`, description: 'Collection only', url: `https://partner.example/items/${id}`,
  location: { lat: 40.73, lng: -73.99, country: 'US' }, price: { amount: '20.00', currency: 'USD' }, category: 'furniture', condition: 'good', available: true, ...over,
});
const gbItem = (id: string, over: Record<string, any> = {}) => item(id, { location: { lat: 51.5, lng: -0.12, country: 'GB' }, price: { amount: '15.00', currency: 'GBP' }, ...over });

describe('partner-feed sync', () => {
  let app: INestApplication;
  let server: Server;
  let repos: Repos;
  let sync: SyncService;
  let adminToken = '';
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const KEY = 'acme';
  const run = () => http().post(`/admin/sources/${KEY}/sync`).set(bearer(adminToken));
  const listings = async () => (await repos.listings.search({ publicOnly: false, sort: 'newest', offset: 0, limit: 500 })).items.filter((l) => l.sourceKey === KEY);

  beforeAll(async () => {
    server = await feedServer();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`;
    const categories = ['furniture', 'electronics', 'other'];
    const sources: RegisteredSource[] = [
      {
        provider: new JsonFeedProvider({ key: KEY, name: 'Acme Giveaways', url, apiKey: fx.key, countries: ['US', 'GB'], categories }),
        defaults: { key: KEY, name: 'Acme Giveaways', kind: 'API_PROVIDER', countries: ['US', 'GB'], expireAfterHours: 48, retireAfterHours: 72, recheckIntervalHours: null, rateLimitPerMinute: null, attribution: 'Listings supplied by Acme Giveaways', attributionUrl: 'https://acme.example', permissionNote: 'Written agreement with Acme, 2026-09-30, ref FR-1' },
      },
      {
        provider: new JsonFeedProvider({ key: 'nokey', name: 'No Key Co', url, apiKey: null, countries: [], categories }),
        defaults: { key: 'nokey', name: 'No Key Co', kind: 'API_PROVIDER', countries: [], expireAfterHours: 48, retireAfterHours: 72, recheckIntervalHours: null, rateLimitPerMinute: null, attribution: 'No Key Co', attributionUrl: null, permissionNote: null },
      },
    ];
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SOURCES).useValue(sources).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    repos = app.get<Repos>(REPOS);
    sync = app.get(SyncService);
    sync.sleep = async () => undefined;
    sync.backoff = { sleep: async () => undefined, baseMs: 1, maxMs: 5 };
    const email = `admin${Date.now()}@example.com`;
    const reg = await http().post('/auth/register').send({ email, password: 'correct-horse-battery', displayName: 'Admin' }).expect(201);
    await repos.users.update(reg.body.user.id, { role: 'ADMIN' });
    adminToken = reg.body.accessToken;
  });
  afterAll(async () => { await app?.close(); server?.close(); });
  beforeEach(() => { fx.items = {}; fx.hits = []; fx.script = []; fx.failOnPage = undefined; });

  it('keeps admin endpoints away from ordinary users', async () => {
    const u = await http().post('/auth/register').send({ email: `u${Date.now()}@example.com`, password: 'correct-horse-battery', displayName: 'U1' }).expect(201);
    expect((await http().get('/admin/sources').set(bearer(u.body.accessToken))).status).toBe(403);
    expect((await http().post(`/admin/sources/${KEY}/sync`).set(bearer(u.body.accessToken))).status).toBe(403);
  });

  it('lists sources as switched off, with their permission basis, until an admin turns one on', async () => {
    const r = await http().get('/admin/sources').set(bearer(adminToken)).expect(200);
    const acme = r.body.find((s: any) => s.key === KEY);
    expect(acme).toMatchObject({ enabled: false, configured: true, attribution: 'Listings supplied by Acme Giveaways', permissionNote: expect.stringContaining('Written agreement') });
    expect(r.body.find((s: any) => s.key === 'nokey')).toMatchObject({ configured: false, setup: expect.stringContaining('PARTNER_FEED_NOKEY_API_KEY') });
    fx.items.US = [item('1')];
    const skipped = await run().expect(201);
    expect(skipped.body.status).toBe('SKIPPED');
    expect(fx.hits).toHaveLength(0); // an off source is never contacted
    expect(await listings()).toHaveLength(0);
  });

  it('refuses to switch on a source with no recorded permission', async () => {
    const r = await http().post('/admin/sources/nokey/enabled').set(bearer(adminToken)).send({ enabled: true });
    expect(r.status).toBe(400);
    expect((await http().post('/admin/sources/direct/enabled').set(bearer(adminToken)).send({ enabled: true })).status).toBe(404);
  });

  describe('once enabled', () => {
    beforeAll(async () => {
      await http().post(`/admin/sources/${KEY}/enabled`).set(bearer(adminToken)).send({ enabled: true }).expect(201);
    });

    it('imports across pages, only for countries the source covers, and records the run', async () => {
      fx.items.US = [item('u1'), item('u2'), item('u3', { price: undefined }), item('u4', { price: { amount: '0.00', currency: 'USD' }, title: 'Free sofa u4' })];
      fx.items.GB = [gbItem('g1')];
      fx.items.CA = [item('c1', { location: { lat: 43.65, lng: -79.38, country: 'CA' } })]; // CA is enabled here but not covered by the source
      const r = (await run().expect(201)).body;
      expect(r).toMatchObject({ status: 'OK', fetched: 5, created: 5, updated: 0, rejected: 0 });
      expect(new Set(fx.hits.map((h) => h.country))).toEqual(new Set(['US', 'GB']));
      expect(fx.hits.every((h) => h.auth === `Bearer ${fx.key}`)).toBe(true);
      const all = await listings();
      expect(all).toHaveLength(5);
      const byExt = Object.fromEntries(all.map((l) => [l.externalId, l]));
      expect(byExt.u3.priceMinor).toBeNull(); // unknown price is not "free"
      expect(byExt.u3.isFree).toBe(false);
      expect(byExt.u4).toMatchObject({ priceMinor: 0, isFree: true });
      expect(byExt.g1).toMatchObject({ currency: 'GBP', countryCode: 'GB', contactMethod: 'EXTERNAL_LINK', externalUrl: 'https://partner.example/items/g1', sellerUserId: null, status: 'ACTIVE' });
      const runs = (await http().get(`/admin/sources/${KEY}/runs`).set(bearer(adminToken)).expect(200)).body.items;
      expect(runs[0]).toMatchObject({ status: 'OK', created: 5, finishedAt: expect.anything() });
    });

    it('shows the partner and its required attribution to buyers, with no seller contact', async () => {
      const found = (await http().get('/listings').query({ q: 'Free sofa u4' }).expect(200)).body.items;
      expect(found).toHaveLength(1);
      expect(found[0].source).toMatchObject({ key: KEY, name: 'Acme Giveaways', attribution: { text: 'Listings supplied by Acme Giveaways', url: 'https://acme.example' } });
      expect(found[0]).toMatchObject({ contactMethod: 'EXTERNAL_LINK', externalUrl: 'https://partner.example/items/u4' });
      expect(JSON.stringify(found[0])).not.toMatch(/sellerUserId|email/);
    });

    it('updates in place on the next run: no duplicates, new price applied, still confirmed', async () => {
      fx.items.US = [item('u1', { price: { amount: '25.00', currency: 'USD' } }), item('u2')];
      fx.items.GB = [];
      const before = await listings();
      const r = (await run().expect(201)).body;
      expect(r).toMatchObject({ status: 'OK', created: 0, updated: 2 });
      const after = await listings();
      expect(after).toHaveLength(before.length);
      const u1 = after.find((l) => l.externalId === 'u1')!;
      expect(u1.priceMinor).toBe(2500);
      expect(u1.lastConfirmedAt.getTime()).toBeGreaterThan(before.find((l) => l.externalId === 'u1')!.lastConfirmedAt.getTime() - 1);
    });

    it('counts invalid items as rejected and stores nothing for them', async () => {
      const before = (await listings()).length;
      fx.items.US = [item('ok1'), { id: 'bad1', title: 'no location' }, item('bad2', { url: 'http://insecure.example' }), item('bad3', { location: { lat: 40, lng: -73, country: 'CA' } })];
      const r = (await run().expect(201)).body;
      expect(r).toMatchObject({ status: 'OK', created: 1, rejected: 3 });
      expect((await listings()).length).toBe(before + 1);
    });

    it('hides a listing the moment the source says it is gone, and never creates one that is already gone', async () => {
      fx.items.US = [item('u1', { available: false }), item('never', { available: false })];
      const r = (await run().expect(201)).body;
      expect(r.created).toBe(0);
      expect((await listings()).find((l) => l.externalId === 'u1')!.status).toBe('CONFIRMED_UNAVAILABLE');
      expect((await listings()).find((l) => l.externalId === 'never')).toBeUndefined();
      const visible = (await http().get('/listings').query({ q: 'Item u1' }).expect(200)).body.items;
      expect(visible).toHaveLength(0);
    });

    it('does not undo a moderator removal when the feed sends the item again', async () => {
      const l = (await listings()).find((x) => x.externalId === 'u2')!;
      await repos.listings.update(l.id, { status: 'REMOVED' });
      fx.items.US = [item('u2')];
      await run().expect(201);
      expect((await repos.listings.findById(l.id))!.status).toBe('REMOVED');
    });

    it('retries rate limits and server errors, then succeeds', async () => {
      fx.script = [{ status: 429, retryAfter: 1 }, { status: 503 }];
      fx.items.US = [item('retry1')];
      const r = (await run().expect(201)).body;
      expect(r).toMatchObject({ status: 'OK', created: 1 });
      expect(fx.hits.length).toBeGreaterThanOrEqual(3);
    });

    it('records a rejected key as a failure, with nothing stored and no invented data', async () => {
      fx.key = 'rotated-key';
      fx.items.US = [item('late1')];
      const before = (await listings()).length;
      const r = (await run().expect(201)).body;
      fx.key = 'secret-key';
      expect(r.status).toBe('FAILED');
      expect(r.message).toMatch(/refused our key/);
      expect((await listings()).length).toBe(before);
      expect(fx.hits).toHaveLength(1); // a permanent error is not retried
      const runs = (await http().get(`/admin/sources/${KEY}/runs`).set(bearer(adminToken))).body.items;
      expect(runs[0]).toMatchObject({ status: 'FAILED', errorMessage: expect.stringMatching(/refused/) });
    });

    it('keeps what it stored when a later page fails, and says the run was partial', async () => {
      fx.items.US = [item('p1'), item('p2'), item('p3'), item('p4')];
      fx.failOnPage = 1;
      const r = (await run().expect(201)).body;
      expect(r.status).toBe('PARTIAL');
      expect(r.created).toBe(2);
      expect((await listings()).some((l) => l.externalId === 'p1')).toBe(true);
      expect((await listings()).some((l) => l.externalId === 'p3')).toBe(false);
    });

    it('does not run two syncs of one source at once', async () => {
      fx.items.US = [item('c1'), item('c2')];
      const [a, b] = await Promise.all([sync.syncSource(KEY), sync.syncSource(KEY)]);
      expect([a.status, b.status].sort()).toEqual(['OK', 'SKIPPED']);
    });

    it('applies the source\'s own freshness rule: unconfirmed for 48h+ means possibly expired', async () => {
      const l = (await listings()).find((x) => x.externalId === 'c1')!;
      await repos.listings.update(l.id, { lastConfirmedAt: new Date(Date.now() - 50 * 3_600_000) });
      await http().post('/admin/jobs/expire').set(bearer(adminToken)).expect(201);
      expect((await repos.listings.findById(l.id))!.status).toBe('POSSIBLY_EXPIRED');
      // The feed lists it again, which is fresh evidence: it comes back.
      fx.items.US = [item('c1')];
      await run().expect(201);
      expect((await repos.listings.findById(l.id))!.status).toBe('ACTIVE');
    });

    it('stops contacting a source once it is switched off, and audits the change', async () => {
      await http().post(`/admin/sources/${KEY}/enabled`).set(bearer(adminToken)).send({ enabled: false }).expect(201);
      fx.hits = [];
      expect((await run().expect(201)).body.status).toBe('SKIPPED');
      expect(fx.hits).toHaveLength(0);
      const audit = (await http().get('/admin/audit').set(bearer(adminToken))).body;
      expect(JSON.stringify(audit)).toContain('SOURCE_DISABLED');
      await http().post(`/admin/sources/${KEY}/enabled`).set(bearer(adminToken)).send({ enabled: true }).expect(201);
    });
  });

  it('is registered as a scheduled job', () => {
    expect((app.get(JobsService) as any).extra.map((d: any) => d.name)).toContain('sync-sources');
  });

  it('reports a source without credentials as not configured instead of calling out', async () => {
    await repos.sources.setEnabled('nokey', true);
    fx.hits = [];
    const r = await sync.syncSource('nokey');
    expect(r.status).toBe('NOT_CONFIGURED');
    expect(r.message).toContain('API_KEY');
    expect(fx.hits).toHaveLength(0);
  });
});
