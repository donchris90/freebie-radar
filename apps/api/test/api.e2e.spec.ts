import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PUSH_SENDER, REPOS, Repos, PushMessage } from '../src/domain/ports';
import { AlertsService } from '../src/engagement/alerts';
import { configureApp } from '../src/main';

let counter = 0;
const uniq = () => `${Date.now()}${++counter}`;

function fakePush() {
  const sent: PushMessage[] = [];
  return {
    sent,
    isConfigured: () => true,
    send: async (m: PushMessage) => { sent.push(m); return { sent: true }; },
  };
}

async function boot() {
  const push = fakePush();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PUSH_SENDER).useValue(push).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, push, repos: app.get<Repos>(REPOS), alerts: app.get(AlertsService) };
}

async function signup(app: INestApplication, over: Record<string, unknown> = {}) {
  const email = `u${uniq()}@example.com`;
  const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'correct-horse-battery', displayName: 'Tester', ...over });
  expect(res.status).toBe(201);
  return { token: res.body.accessToken as string, id: res.body.user.id as string, email };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const payload = (over: Record<string, unknown> = {}) => ({
  title: `Oak desk ${uniq()}`,
  description: 'Solid oak, a few scratches.',
  categoryKey: 'furniture',
  condition: 'GOOD',
  price: '50',
  currency: 'USD',
  lat: 40.7128,
  lng: -74.006,
  locationLabel: 'Brooklyn, NY',
  ...over,
});

async function makeListing(app: INestApplication, token: string, over: Record<string, unknown> = {}) {
  const res = await request(app.getHttpServer()).post('/listings').set(bearer(token)).send(payload(over));
  expect(res.status).toBe(201);
  return res.body;
}

describe('Freebie Radar API', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => { ctx = await boot(); app = ctx.app; });
  afterAll(async () => { await app.close(); });

  describe('auth and access control', () => {
    it('serves health without auth', async () => {
      expect((await http().get('/health')).body).toEqual({ status: 'ok' });
    });

    it('registers, logs in and returns the profile without secrets', async () => {
      const u = await signup(app);
      const login = await http().post('/auth/login').send({ email: u.email, password: 'correct-horse-battery' });
      expect(login.status).toBe(201);
      const me = await http().get('/me').set(bearer(login.body.accessToken));
      expect(me.status).toBe(200);
      expect(me.body.email).toBe(u.email);
      expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    });

    it('rejects weak passwords, bad emails, unknown fields and unsupported countries', async () => {
      const post = (b: object) => http().post('/auth/register').send(b);
      expect((await post({ email: 'a@b.co', password: 'short', displayName: 'X1' })).status).toBe(400);
      expect((await post({ email: 'nope', password: 'long-enough-password', displayName: 'X1' })).status).toBe(400);
      expect((await post({ email: `x${uniq()}@b.co`, password: 'long-enough-password', displayName: 'X1', role: 'ADMIN' })).status).toBe(400);
      expect((await post({ email: `x${uniq()}@b.co`, password: 'long-enough-password', displayName: 'X1', countryCode: 'ZZ' })).status).toBe(400);
    });

    it('rejects duplicate emails and wrong passwords generically', async () => {
      const u = await signup(app);
      expect((await http().post('/auth/register').send({ email: u.email, password: 'correct-horse-battery', displayName: 'Dup' })).status).toBe(409);
      const bad = await http().post('/auth/login').send({ email: u.email, password: 'wrong-password-123' });
      expect(bad.status).toBe(401);
      const unknown = await http().post('/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-123' });
      expect(unknown.body.message).toBe(bad.body.message);
    });

    it('requires a valid token for protected routes', async () => {
      expect((await http().get('/me')).status).toBe(401);
      expect((await http().get('/me').set(bearer('garbage'))).status).toBe(401);
      expect((await http().post('/listings').send(payload())).status).toBe(401);
    });

    it('keeps admin endpoints away from ordinary users', async () => {
      const u = await signup(app);
      for (const path of ['/admin/reports', '/admin/stats', '/admin/audit', '/admin/appeals']) {
        expect((await http().get(path).set(bearer(u.token))).status).toBe(403);
      }
      expect((await http().post('/admin/jobs/expire').set(bearer(u.token))).status).toBe(403);
      expect((await http().get('/admin/stats')).status).toBe(401);
    });

    it('cannot self-promote through preferences', async () => {
      const u = await signup(app);
      const r = await http().patch('/me/preferences').set(bearer(u.token)).send({ role: 'ADMIN' });
      expect(r.status).toBe(400);
    });
  });

  describe('seller submissions', () => {
    it('creates a paid listing and never exposes exact coordinates or seller identity', async () => {
      const u = await signup(app);
      const l = await makeListing(app, u.token, { lat: 40.712776, lng: -74.005974 });
      expect(l.price).toMatchObject({ minor: 5000, currency: 'USD', label: '$50.00', isFree: false });
      expect(l.location).toMatchObject({ lat: 40.71, lng: -74.01, precision: 'approximate' });
      const raw = JSON.stringify(l);
      expect(raw).not.toContain('40.712776');
      expect(raw).not.toContain(u.id);
      expect(raw).not.toContain(u.email);
      expect(l.freshness.label).toMatch(/^Posted/);
      expect(l.risk.label).toBe('No major risk signals detected');
    });

    it('treats price 0 as free and a missing price as "price not stated"', async () => {
      const u = await signup(app);
      const free = await makeListing(app, u.token, { price: '0', title: `Free sofa ${uniq()}` });
      expect(free.price).toMatchObject({ minor: 0, label: 'Free', isFree: true });
      const unknown = await makeListing(app, u.token, { price: undefined, title: `Mystery box ${uniq()}`, lat: 41.2 });
      expect(unknown.price).toMatchObject({ minor: null, label: 'Price not stated', isFree: false });
      expect(unknown.dealScore).toBeNull();
    });

    it('validates currency, price, coordinates, category and urls', async () => {
      const u = await signup(app);
      const post = (o: Record<string, unknown>) => http().post("/listings").set(bearer(u.token)).send(payload(o));
      expect((await post({ currency: 'XX' })).status).toBe(400);
      expect((await post({ currency: 'ZZZ' })).status).toBe(400);
      expect((await post({ price: '-5' })).status).toBe(400);
      expect((await post({ price: '10.999' })).status).toBe(400);
      expect((await post({ price: 'abc' })).status).toBe(400);
      expect((await post({ lat: 95, lng: 0 })).status).toBe(400);
      expect((await post({ categoryKey: 'weapons' })).status).toBe(400);
      expect((await post({ title: 'ab' })).status).toBe(400);
      expect((await post({ externalUrl: 'javascript:alert(1)' })).status).toBe(400);
      expect((await post({ contactMethod: 'EXTERNAL_LINK' })).status).toBe(400);
      expect((await post({ imageUrls: Array(9).fill('https://img.example.com/a.jpg') })).status).toBe(400);
      expect((await post({ countryCode: 'ZZ' })).status).toBe(400);
    });

    it('handles zero-decimal and three-decimal currencies exactly', async () => {
      const u = await signup(app);
      const jpy = await makeListing(app, u.token, { currency: 'JPY', price: '1500', title: `JPY item ${uniq()}`, lat: 35.68, lng: 139.76, countryCode: 'US' });
      expect(jpy.price.minor).toBe(1500);
      const bad = await http().post('/listings').set(bearer(u.token)).send(payload({ currency: 'JPY', price: '15.5' }));
      expect(bad.status).toBe(400);
    });

    it('rejects an exact duplicate from the same seller but links one from another seller', async () => {
      const a = await signup(app);
      const b = await signup(app);
      const body = payload({ title: `Unique lamp ${uniq()}`, lat: 41.0, lng: -73.0 });
      await http().post('/listings').set(bearer(a.token)).send(body).expect(201);
      await http().post('/listings').set(bearer(a.token)).send(body).expect(409);
      const other = await http().post('/listings').set(bearer(b.token)).send(body).expect(201);
      // the linked duplicate stays out of public search so it cannot double-count
      const found = await http().get('/listings').query({ q: 'Unique lamp' });
      expect(found.body.items.map((i: { id: string }) => i.id)).not.toContain(other.body.id);
    });

    it('holds a listing with several risk signals for review instead of publishing it', async () => {
      const u = await signup(app);
      const l = await makeListing(app, u.token, {
        title: `Great laptop ${uniq()}`,
        description: 'Send a deposit via Western Union first, then message me on WhatsApp.',
        price: '10', categoryKey: 'electronics', lat: 33.0, lng: -97.0,
      });
      // advance payment (40) + off-platform (15) = 55 -> caution, still public
      expect(l.risk.level).toBe('EXERCISE_CAUTION');
      expect(l.risk.signals.join(' ')).toMatch(/deposits|payment/i);
      const worse = await makeListing(app, u.token, {
        title: `Phone ${uniq()}`, description: 'Western Union deposit only. WhatsApp me.', categoryKey: 'electronics', lat: 33.1, lng: -97.1,
      });
      expect(['EXERCISE_CAUTION', 'UNDER_REVIEW']).toContain(worse.risk.level);
    });

    it('lists only the seller\'s own listings under /listings/mine', async () => {
      const a = await signup(app);
      const b = await signup(app);
      await makeListing(app, a.token, { lat: 42.1 });
      const mine = await http().get('/listings/mine').set(bearer(b.token));
      expect(mine.body.items).toHaveLength(0);
      expect((await http().get('/listings/mine').set(bearer(a.token))).body.items).toHaveLength(1);
    });
  });

  describe('search, feeds and pagination', () => {
    const base = { lat: 51.5074, lng: -0.1278 };
    let sellerToken: string;
    beforeAll(async () => {
      sellerToken = (await signup(app, { countryCode: 'GB' })).token;
      const mk = (o: Record<string, unknown>) => makeListing(app, sellerToken, { currency: 'GBP', countryCode: 'GB', ...o });
      await mk({ title: 'Zebra chair alpha', categoryKey: 'furniture', price: '0', ...base });
      await mk({ title: 'Zebra bookshelf beta', categoryKey: 'furniture', price: '25', condition: 'FAIR', lat: 51.52, lng: -0.1 });
      await mk({ title: 'Zebra monitor gamma', categoryKey: 'electronics', price: '90', condition: 'NEW', lat: 51.6, lng: -0.3 });
      await mk({ title: 'Zebra toy delta', categoryKey: 'toys', price: '0', lat: 53.48, lng: -2.24 }); // Manchester
    });

    it('filters by keyword, category, free-only, condition and price with currency', async () => {
      const s = (q: object) => http().get('/listings').query(q);
      expect((await s({ q: 'zebra' })).body.total).toBe(4);
      expect((await s({ q: 'zebra', category: 'furniture' })).body.total).toBe(2);
      expect((await s({ q: 'zebra', freeOnly: 'true' })).body.total).toBe(2);
      expect((await s({ q: 'zebra', condition: 'NEW' })).body.total).toBe(1);
      expect((await s({ q: 'zebra', minPrice: '20', maxPrice: '100', currency: 'GBP' })).body.total).toBe(2);
      expect((await s({ q: 'zebra', minPrice: '20', maxPrice: '100', currency: 'USD' })).body.total).toBe(0); // no currency mixing
      expect((await s({ q: 'zebra', category: 'weapons' })).status).toBe(400);
      expect((await s({ q: 'zebra', minPrice: 'abc' })).status).toBe(400);
    });

    it('filters by radius in miles and kilometres and sorts by distance', async () => {
      const near = await http().get('/listings').query({ q: 'zebra', ...base, radius: 5, unit: 'mi' });
      expect(near.body.items.map((i: { title: string }) => i.title)).toEqual(['Zebra chair alpha', 'Zebra bookshelf beta']);
      expect(near.body.items[0].distance.label).toMatch(/mi$/);
      const all = await http().get('/listings').query({ q: 'zebra', ...base, radius: 500, unit: 'km', sort: 'nearest' });
      const km = all.body.items.map((i: { distance: { km: number } }) => i.distance.km);
      expect([...km].sort((a, b) => a - b)).toEqual(km);
    });

    it('rejects invalid coordinates, a lone coordinate, and a radius without a location', async () => {
      expect((await http().get('/listings').query({ lat: 200, lng: 0 })).status).toBe(400);
      expect((await http().get('/listings').query({ lat: 10 })).status).toBe(400);
      expect((await http().get('/listings').query({ radius: 5 })).status).toBe(400);
      expect((await http().get('/listings').query({ sort: 'nearest' })).status).toBe(400);
    });

    it('paginates with an opaque cursor and rejects tampered cursors', async () => {
      const p1 = await http().get('/listings').query({ q: 'zebra', limit: 3 });
      expect(p1.body.items).toHaveLength(3);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await http().get('/listings').query({ q: 'zebra', limit: 3, cursor: p1.body.nextCursor });
      expect(p2.body.items).toHaveLength(1);
      expect(p2.body.nextCursor).toBeNull();
      const ids = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
      expect(new Set(ids).size).toBe(4);
      expect((await http().get('/listings').query({ cursor: '!!!' })).status).toBe(400);
      expect((await http().get('/listings').query({ limit: 500 })).status).toBe(400);
    });

    it('serves the Free Near Me feed with only genuinely free items, nearest first', async () => {
      const r = await http().get('/feed/free-near-me').query({ q: 'zebra', ...base });
      expect(r.body.items.map((i: { title: string }) => i.title)).toEqual(['Zebra chair alpha', 'Zebra toy delta']);
      expect(r.body.items.every((i: { price: { isFree: boolean } }) => i.price.isFree)).toBe(true);
    });
  });

  describe('deal score evidence', () => {
    it('gives no score without enough comparable listings, and says why', async () => {
      const u = await signup(app);
      const l = await makeListing(app, u.token, { categoryKey: 'tools', price: '20', title: `Lonely drill ${uniq()}`, lat: 30.0, lng: -90.0 });
      expect(l.dealScore).toBeNull();
      expect(l.dealScoreNote).toMatch(/at least 5/);
    });

    it('scores with comparables, shows the sample size and range, and never mixes currencies', async () => {
      const prices = ['80', '85', '90', '85', '95', '88'];
      for (const [i, p] of prices.entries()) {
        const s = await signup(app);
        await makeListing(app, s.token, { categoryKey: 'sports', price: p, title: `Bicycle model${['aa', 'bb', 'cc', 'dd', 'ee', 'ff'][i]} ${uniq()}`, lat: 29.0 + i * 0.5, lng: -95.0 });
      }
      const seller = await signup(app);
      const deal = await makeListing(app, seller.token, { categoryKey: 'sports', price: '40', title: `Road bike bargain ${uniq()}`, lat: 29.3, lng: -95.0 });
      expect(deal.dealScore.score).toBeGreaterThanOrEqual(70);
      expect(deal.dealScore.explanation).toMatch(/Listed at \$40\.00 compared with 6 comparable listings/);
      expect(deal.dealScore.evidence).toMatchObject({ sampleSize: 6 });
      expect(deal.dealScore.evidence.limitations.join(' ')).toMatch(/asking prices/);
      const gbp = await makeListing(app, seller.token, { categoryKey: 'sports', currency: 'GBP', price: '40', title: `Pound bike ${uniq()}`, lat: 29.9, lng: -95.0 });
      expect(gbp.dealScore).toBeNull();
      const detail = await http().get(`/listings/${deal.id}`);
      expect(detail.body.dealScore.score).toBe(deal.dealScore.score);
      expect(detail.body.safetyGuidance.join(' ')).toMatch(/public place/);
    });

    it('lists exceptional deals only when evidence supports them', async () => {
      const r = await http().get('/feed/exceptional-deals').query({ category: 'sports' });
      expect(r.status).toBe(200);
      for (const i of r.body.items) expect(i.dealScore.score).toBeGreaterThanOrEqual(75);
    });
  });

  describe('freshness, availability and reports', () => {
    it('does not remove a listing on one unavailable report, but does after distinct reporters', async () => {
      const seller = await signup(app);
      const l = await makeListing(app, seller.token, { title: `Report me ${uniq()}`, lat: 44.0 });
      const r1 = await signup(app);
      const r2 = await signup(app);
      await http().post(`/listings/${l.id}/report`).set(bearer(r1.token)).send({ reason: 'UNAVAILABLE' }).expect(201);
      expect((await http().get(`/listings/${l.id}`)).body.status).toBe('ACTIVE');
      await http().post(`/listings/${l.id}/report`).set(bearer(r1.token)).send({ reason: 'UNAVAILABLE' }).expect(409);
      await http().post(`/listings/${l.id}/report`).set(bearer(r2.token)).send({ reason: 'EXPIRED' }).expect(201);
      await http().get(`/listings/${l.id}`).expect(404);
      const search = await http().get('/listings').query({ q: 'Report me' });
      expect(search.body.items.map((i: { id: string }) => i.id)).not.toContain(l.id);
      // owner still sees it and can confirm availability, which is positive evidence
      expect((await http().get(`/listings/${l.id}`).set(bearer(seller.token))).body.status).toBe('REPORTED_UNAVAILABLE');
      const confirmed = await http().post(`/listings/${l.id}/confirm`).set(bearer(seller.token));
      expect(confirmed.body.status).toBe('ACTIVE');
      await http().get(`/listings/${l.id}`).expect(200);
    });

    it('stops people reporting their own listing, and requires a login', async () => {
      const seller = await signup(app);
      const l = await makeListing(app, seller.token, { lat: 44.5 });
      const other = await signup(app);
      await http().post(`/listings/${l.id}/report`).set(bearer(seller.token)).send({ reason: 'SCAM' }).expect(400);
      await http().post(`/listings/${l.id}/report`).send({ reason: 'SCAM' }).expect(401);
      await http().post(`/listings/${l.id}/report`).set(bearer(other.token)).send({ reason: 'NOT_A_REASON' }).expect(400);
    });

    it('holds a heavily reported listing for review and labels it neutrally', async () => {
      const seller = await signup(app);
      const l = await makeListing(app, seller.token, { title: `Sketchy ${uniq()}`, lat: 45.0 });
      for (let i = 0; i < 5; i++) {
        const r = await signup(app);
        await http().post(`/listings/${l.id}/report`).set(bearer(r.token)).send({ reason: 'SUSPICIOUS', details: 'looks off' }).expect(201);
      }
      await http().get(`/listings/${l.id}`).expect(404);
      const owner = await http().get(`/listings/${l.id}`).set(bearer(seller.token));
      expect(owner.body.status).toBe('UNDER_REVIEW');
      expect(owner.body.risk.label).toBe('Under review');
      expect(JSON.stringify(owner.body.risk)).not.toMatch(/scam|criminal|fraud/i);
    });

    it('expires stale listings through the job without ever auto-confirming them', async () => {
      const admin = await signup(app);
      await ctx.repos.users.update(admin.id, { role: 'ADMIN' });
      const seller = await signup(app);
      const l = await makeListing(app, seller.token, { title: `Stale item ${uniq()}`, lat: 46.0 });
      await ctx.repos.listings.update(l.id, { lastConfirmedAt: new Date(Date.now() - 400 * 3_600_000), postedAt: new Date(Date.now() - 400 * 3_600_000) });
      const run = await http().post('/admin/jobs/expire').set(bearer(admin.token));
      expect(run.body.expired).toBeGreaterThanOrEqual(1);
      const d = await http().get(`/listings/${l.id}`);
      expect(d.body.status).toBe('POSSIBLY_EXPIRED');
      expect(d.body.freshness.label).toMatch(/^May no longer be available/);
      // running again is idempotent
      const again = await http().post('/admin/jobs/expire').set(bearer(admin.token));
      expect(again.body.expired).toBe(0);
    });
  });

  describe('moderation, audit trail and appeals', () => {
    it('lets a moderator remove a listing with an audit trail, and the owner appeal it', async () => {
      const admin = await signup(app);
      await ctx.repos.users.update(admin.id, { role: 'ADMIN' });
      const mod = await signup(app);
      await ctx.repos.users.update(mod.id, { role: 'MODERATOR' });
      const seller = await signup(app);
      const reporter = await signup(app);
      const l = await makeListing(app, seller.token, { title: `Needs moderation ${uniq()}`, lat: 47.0 });
      const rep = await http().post(`/listings/${l.id}/report`).set(bearer(reporter.token)).send({ reason: 'PROHIBITED_ITEM' }).expect(201);

      const queue = await http().get('/admin/reports').set(bearer(mod.token));
      expect(queue.body.items.some((i: { report: { id: string } }) => i.report.id === rep.body.reportId)).toBe(true);
      await http().post(`/admin/reports/${rep.body.reportId}/resolve`).set(bearer(mod.token)).send({ action: 'REMOVE_LISTING' }).expect(400); // reason required
      const done = await http().post(`/admin/reports/${rep.body.reportId}/resolve`).set(bearer(mod.token)).send({ action: 'REMOVE_LISTING', reason: 'Prohibited item per policy' });
      expect(done.status).toBe(201);
      expect(done.body.status).toBe('REMOVED');
      await http().get(`/listings/${l.id}`).expect(404);

      const audit = await http().get('/admin/audit').set(bearer(admin.token));
      expect(audit.body.items.some((a: { action: string; entityId: string }) => a.action === 'MODERATION_REMOVE_LISTING' && a.entityId === l.id)).toBe(true);
      expect((await http().get('/admin/audit').set(bearer(mod.token))).status).toBe(403); // audit log is admin-only

      // the owner appeals; another user cannot
      const stranger = await signup(app);
      await http().post('/appeals').set(bearer(stranger.token)).send({ moderationId: done.body.moderationId, message: 'This was a mistake, please look again.' }).expect(404);
      const appeal = await http().post('/appeals').set(bearer(seller.token)).send({ moderationId: done.body.moderationId, message: 'This is a normal household item, please review.' });
      expect(appeal.status).toBe(201);
      await http().post('/appeals').set(bearer(seller.token)).send({ moderationId: done.body.moderationId, message: 'Second appeal for the same decision.' }).expect(409);

      const resolved = await http().post(`/admin/appeals/${appeal.body.id}/resolve`).set(bearer(mod.token)).send({ decision: 'UPHELD', note: 'Item is permitted' });
      expect(resolved.body.status).toBe('UPHELD');
      await http().get(`/listings/${l.id}`).expect(200);
    });

    it('reports real aggregate stats to admins only', async () => {
      const admin = await signup(app);
      await ctx.repos.users.update(admin.id, { role: 'ADMIN' });
      const s = await http().get('/admin/stats').set(bearer(admin.token));
      expect(s.status).toBe(200);
      expect(s.body.users).toBeGreaterThan(0);
      expect(s.body.listingsBySource.direct).toBeGreaterThan(0);
    });
  });

  describe('Radar alerts', () => {
    const setup = async (prefs: Record<string, unknown> = {}) => {
      const user = await signup(app);
      await http().patch('/me/preferences').set(bearer(user.token)).send({ pushToken: 'ExpoPushToken[test]', ...prefs }).expect(200);
      return user;
    };
    const macbookAlert = (over: Record<string, unknown> = {}) => ({
      name: 'MacBook under $250', keywords: ['macbook'], maxPriceMinor: 25000, currency: 'USD', radiusKm: 16, centerLat: 40.73, centerLng: -73.99, ...over,
    });
    const macbook = (token: string, over: Record<string, unknown> = {}) =>
      makeListing(app, token, { title: `Used MacBook Air ${uniq()}`, categoryKey: 'electronics', price: '200', ...over });

    it('creates the headline alert, delivers once, and never duplicates', async () => {
      const buyer = await setup();
      const before = ctx.push.sent.length;
      await http().post('/alerts').set(bearer(buyer.token)).send(macbookAlert()).expect(201);
      const seller = await signup(app);
      const l = await macbook(seller.token);
      expect(ctx.push.sent.length).toBe(before + 1);
      expect(ctx.push.sent[ctx.push.sent.length - 1].body).toMatch(/\$200\.00/);

      const rec = (await ctx.repos.listings.findById(l.id))!;
      const again = await ctx.alerts.processNewListing(rec);
      expect(again.duplicates).toBe(1);
      expect(ctx.push.sent.length).toBe(before + 1);
      const history = await http().get('/alerts/history').set(bearer(buyer.token));
      expect(history.body.filter((d: { listingId: string }) => d.listingId === l.id)).toHaveLength(1);
      expect(history.body[0].status).toBe('SENT');
    });

    it('does not alert on non-matching listings or the user\'s own listing', async () => {
      const buyer = await setup();
      await http().post('/alerts').set(bearer(buyer.token)).send(macbookAlert({ keywords: ['ownword'] })).expect(201);
      const before = ctx.push.sent.length;
      const seller = await signup(app);
      await macbook(seller.token, { price: '400', title: `ownword over budget ${uniq()}` }); // over budget
      await makeListing(app, seller.token, { title: `Wooden shelf ${uniq()}`, lat: 40.73, lng: -73.99 }); // wrong keyword
      await macbook(seller.token, { lat: 48.8, lng: 2.35, title: `ownword Paris ${uniq()}` }); // too far
      await macbook(buyer.token, { lat: 40.74, title: `ownword my own ${uniq()}` }); // own listing
      expect(ctx.push.sent.length).toBe(before);
    });

    it('enforces a daily push limit and records the skip', async () => {
      const buyer = await setup({ maxPushPerDay: 1 });
      await http().post('/alerts').set(bearer(buyer.token)).send(macbookAlert({ keywords: ['limitword'] })).expect(201);
      const seller = await signup(app);
      const before = ctx.push.sent.length;
      await macbook(seller.token, { title: `limitword one ${uniq()}`, lat: 40.731 });
      await macbook(seller.token, { title: `limitword two ${uniq()}`, lat: 40.732 });
      expect(ctx.push.sent.length).toBe(before + 1);
      const hist = (await http().get('/alerts/history').set(bearer(buyer.token))).body.map((d: { status: string }) => d.status).sort();
      expect(hist).toEqual(['SENT', 'SKIPPED_LIMIT']);
    });

    it('defers during quiet hours, then delivers when the dispatcher runs after they end', async () => {
      const hour = new Date().getUTCHours();
      const buyer = await setup({ quietHoursStart: hour, quietHoursEnd: (hour + 1) % 24 });
      await http().post('/alerts').set(bearer(buyer.token)).send(macbookAlert({ keywords: ['quietword'] })).expect(201);
      const admin = await signup(app);
      await ctx.repos.users.update(admin.id, { role: 'ADMIN' });
      const seller = await signup(app);
      const before = ctx.push.sent.length;
      await macbook(seller.token, { title: `quietword item ${uniq()}`, lat: 40.733 });
      expect(ctx.push.sent.length).toBe(before); // deferred, not sent
      expect((await http().get('/alerts/history').set(bearer(buyer.token))).body[0].status).toBe('PENDING');
      await http().patch('/me/preferences').set(bearer(buyer.token)).send({ quietHoursStart: (hour + 5) % 24, quietHoursEnd: (hour + 6) % 24 }).expect(200);
      const run = await http().post('/admin/jobs/dispatch-alerts').set(bearer(admin.token));
      expect(run.body.sent).toBeGreaterThanOrEqual(1);
      expect(ctx.push.sent.length).toBe(before + 1);
    });

    it('records delivery as skipped when push is disabled or no token exists', async () => {
      const buyer = await signup(app); // no push token
      await http().post('/alerts').set(bearer(buyer.token)).send(macbookAlert({ keywords: ['notokenword'] })).expect(201);
      const seller = await signup(app);
      const before = ctx.push.sent.length;
      await macbook(seller.token, { title: `notokenword ${uniq()}`, lat: 40.734 });
      expect(ctx.push.sent.length).toBe(before);
      expect((await http().get('/alerts/history').set(bearer(buyer.token))).body[0].status).toBe('SKIPPED_PREFERENCES');
    });

    it('validates alerts and enforces the plan limit', async () => {
      const u = await signup(app);
      const post = (b: object) => http().post('/alerts').set(bearer(u.token)).send(b);
      expect((await post({ name: 'empty' })).status).toBe(400); // no criteria
      expect((await post({ name: 'x', keywords: ['a'], maxPriceMinor: 100 })).status).toBe(400); // price needs currency
      expect((await post({ name: 'x', keywords: ['a'], minPriceMinor: 500, maxPriceMinor: 100, currency: 'USD' })).status).toBe(400);
      expect((await post({ name: 'x', keywords: ['a'], radiusKm: 5 })).status).toBe(400); // radius needs centre
      expect((await post({ name: 'x', categories: ['weapons'] })).status).toBe(400);
      for (let i = 0; i < 3; i++) await post({ name: `a${i}`, keywords: ['thing'] }).expect(201);
      expect((await post({ name: 'a4', keywords: ['thing'] })).status).toBe(403);
    });

    it('hides other users\' alerts and supports pause and delete', async () => {
      const a = await signup(app);
      const b = await signup(app);
      const alert = (await http().post('/alerts').set(bearer(a.token)).send({ name: 'mine', keywords: ['x1'] })).body;
      await http().patch(`/alerts/${alert.id}`).set(bearer(b.token)).send({ active: false }).expect(404);
      await http().delete(`/alerts/${alert.id}`).set(bearer(b.token)).expect(404);
      expect((await http().patch(`/alerts/${alert.id}`).set(bearer(a.token)).send({ active: false })).body.active).toBe(false);
      await http().delete(`/alerts/${alert.id}`).set(bearer(a.token)).expect(200);
      expect((await http().get('/alerts').set(bearer(a.token))).body).toHaveLength(0);
    });
  });

  describe('saved listings and personalisation', () => {
    it('saves, lists and unsaves; dismissed listings disappear from search', async () => {
      const seller = await signup(app);
      const u = await signup(app);
      const l = await makeListing(app, seller.token, { title: `Savable ${uniq()}`, lat: 49.0 });
      await http().post(`/saved/${l.id}`).set(bearer(u.token)).expect(201);
      expect((await http().get('/saved').set(bearer(u.token))).body.items.map((i: { id: string }) => i.id)).toEqual([l.id]);
      await http().delete(`/saved/${l.id}`).set(bearer(u.token)).expect(200);
      expect((await http().get('/saved').set(bearer(u.token))).body.items).toHaveLength(0);
      await http().post(`/listings/${l.id}/dismiss`).set(bearer(u.token)).expect(201);
      const s = await http().get('/listings').set(bearer(u.token)).query({ q: 'Savable' });
      expect(s.body.items.map((i: { id: string }) => i.id)).not.toContain(l.id);
      await http().post('/saved/does-not-exist').set(bearer(u.token)).expect(404);
    });

    it('explains recommendations and lets the user disable and reset personalisation', async () => {
      const seller = await signup(app);
      const u = await signup(app);
      for (let i = 0; i < 2; i++) await makeListing(app, seller.token, { categoryKey: 'garden', title: `Garden tool ${['rake', 'hoe'][i]} ${uniq()}`, lat: 50.0 + i });
      const l = await makeListing(app, seller.token, { categoryKey: 'garden', title: `Garden hose ${uniq()}`, lat: 50.5 });
      await http().get(`/listings/${l.id}`).set(bearer(u.token));
      const rec = await http().get('/feed/recommended').set(bearer(u.token));
      expect(rec.body.reason).toMatch(/because you recently looked at garden/);
      await http().patch('/me/preferences').set(bearer(u.token)).send({ personalisationEnabled: false }).expect(200);
      const off = await http().get('/feed/recommended').set(bearer(u.token));
      expect(off.body.personalisation).toBe('off');
      expect(off.body.reason).not.toMatch(/because you/);
      await http().patch('/me/preferences').set(bearer(u.token)).send({ personalisationEnabled: true }).expect(200);
      await http().post('/me/personalisation/reset').set(bearer(u.token)).expect(201);
      expect((await http().get('/feed/recommended').set(bearer(u.token))).body.reason).not.toMatch(/because you/);
    });
  });

  describe('reseller profit calculator', () => {
    it('calculates cost, profit, margin and break-even without floats and with a disclaimer', async () => {
      const r = await http().post('/resale/calculate').send({ currency: 'USD', purchase: '100', resale: '200', transport: '10', repair: '20', other: '5', feePercent: '13' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ totalAcquisitionCostMinor: 13500, sellingFeesMinor: 2600, grossProfitMinor: 6500, netProfitMinor: 3900, marginBasisPoints: 1950, breakEvenResaleMinor: 15517 });
      expect(r.body.disclaimer).toMatch(/not guaranteed profits/);
    });

    it('rejects bad input and handles a free purchase', async () => {
      const post = (b: object) => http().post('/resale/calculate').send(b);
      expect((await post({ currency: 'USD', purchase: '-1', resale: '5' })).status).toBe(400);
      expect((await post({ currency: 'USD', purchase: '1', resale: '5', feePercent: '101' })).status).toBe(400);
      expect((await post({ currency: 'USD', purchase: '1', resale: '5', feePercent: '12.555' })).status).toBe(400);
      expect((await post({ currency: 'QQ', purchase: '1', resale: '5' })).status).toBe(400);
      const free = await post({ currency: 'GBP', purchase: '0', resale: '50', transport: '8' });
      expect(free.body.netProfitMinor).toBe(4200);
    });

    it('saves calculations privately and compares them within one currency only', async () => {
      const a = await signup(app);
      const b = await signup(app);
      const save = (token: string, body: object) => http().post('/resale').set(bearer(token)).send(body);
      expect((await save(a.token, { currency: 'USD', purchase: '1', resale: '5' })).status).toBe(400); // label required
      const low = (await save(a.token, { label: 'Lamp', currency: 'USD', purchase: '10', resale: '30' })).body;
      await save(a.token, { label: 'Desk', currency: 'USD', purchase: '50', resale: '200' }).expect(201);
      await save(a.token, { label: 'Chair GBP', currency: 'GBP', purchase: '5', resale: '500' }).expect(201);
      const cmp = await http().get('/resale/compare').set(bearer(a.token));
      const usd = cmp.body.groups.find((g: { currency: string }) => g.currency === 'USD');
      expect(usd.ranked.map((x: { label: string }) => x.label)).toEqual(['Desk', 'Lamp']);
      expect(cmp.body.groups).toHaveLength(2);
      expect((await http().get('/resale').set(bearer(b.token))).body.items).toHaveLength(0);
      await http().delete(`/resale/${low.id}`).set(bearer(b.token)).expect(404);
      await http().delete(`/resale/${low.id}`).set(bearer(a.token)).expect(200);
    });
  });

  describe('account deletion and privacy', () => {
    it('removes the user\'s listings, anonymises the account and invalidates the token', async () => {
      const u = await signup(app);
      const l = await makeListing(app, u.token, { title: `Delete me ${uniq()}`, lat: 52.0 });
      await http().delete('/me').set(bearer(u.token)).expect(200);
      await http().get('/me').set(bearer(u.token)).expect(401);
      await http().get(`/listings/${l.id}`).expect(404);
      const rec = await ctx.repos.users.findById(u.id);
      expect(rec?.email).toMatch(/^deleted\+/);
      expect(rec?.passwordHash).toBe('');
      await http().post('/auth/login').send({ email: u.email, password: 'correct-horse-battery' }).expect(401);
    });

    it('stores approximate home location rounded, and exposes the push token only as a flag', async () => {
      const u = await signup(app);
      const r = await http().patch('/me/preferences').set(bearer(u.token)).send({ homeLat: 40.712776, homeLng: -74.005974, pushToken: 'ExpoPushToken[abc]' });
      expect(r.body.prefs).toMatchObject({ homeLat: 40.71, homeLng: -74.01, pushTokenSet: true });
      expect(JSON.stringify(r.body)).not.toContain('ExpoPushToken');
      expect((await http().patch('/me/preferences').set(bearer(u.token)).send({ homeLat: 10 })).status).toBe(400);
      expect((await http().patch('/me/preferences').set(bearer(u.token)).send({ homeLat: 999, homeLng: 0 })).status).toBe(400);
    });
  });
});
