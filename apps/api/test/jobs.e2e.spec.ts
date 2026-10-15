/**
 * Proves the scheduled jobs run the app's real logic without anyone pressing an admin button.
 * Needs a real Redis: set REDIS_TEST_URL (e.g. redis://127.0.0.1:6381). Skipped otherwise.
 * Uses the in-memory store, so it does not need PostgreSQL.
 */
const REDIS = process.env.REDIS_TEST_URL;
process.env.NODE_ENV = 'test';
process.env.AUTH_THROTTLE_LIMIT = '10000';
process.env.THROTTLE_LIMIT = '100000';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.STORE = 'memory';
if (REDIS) {
  process.env.REDIS_URL = REDIS;
  process.env.JOBS_ENABLED = 'true';
  process.env.JOBS_INTERVAL_MS = '400';
  process.env.JOBS_QUEUE_NAME = `e2e-jobs-${process.pid}-${Date.now()}`;
}

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PUSH_SENDER, REPOS, Repos, PushMessage } from '../src/domain/ports';
import { configureApp } from '../src/main';

const d = REDIS ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(100); }
  return false;
}
let counter = 0;
const uniq = () => `${Date.now()}${++counter}`;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

d('scheduled jobs inside the running app', () => {
  let app: INestApplication;
  let repos: Repos;
  const sent: PushMessage[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const push = { isConfigured: () => true, send: async (m: PushMessage) => { sent.push(m); return { sent: true }; } };
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PUSH_SENDER).useValue(push).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    app.enableShutdownHooks();
    repos = app.get<Repos>(REPOS);
  });
  afterAll(async () => {
    await app?.close();
    const c = new IORedis(REDIS!, { maxRetriesPerRequest: null });
    const q = new Queue(process.env.JOBS_QUEUE_NAME!, { connection: c });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close(); c.disconnect();
  });

  async function signup(over: Record<string, unknown> = {}) {
    const email = `u${uniq()}@example.com`;
    const r = await http().post('/auth/register').send({ email, password: 'correct-horse-battery', displayName: 'Tester', ...over }).expect(201);
    return { token: r.body.accessToken as string, id: r.body.user.id as string };
  }

  it('expires a stale listing on its own', async () => {
    const seller = await signup();
    const res = await http().post('/listings').set(bearer(seller.token)).send({ title: `Stale thing ${uniq()}`, description: 'old', categoryKey: 'furniture', condition: 'GOOD', price: '20', currency: 'USD', lat: 41.0, lng: -73.0, locationLabel: 'NY' }).expect(201);
    await repos.listings.update(res.body.id, { lastConfirmedAt: new Date(Date.now() - 400 * 3_600_000), postedAt: new Date(Date.now() - 400 * 3_600_000) });
    expect(await until(async () => (await repos.listings.findById(res.body.id))!.status !== 'ACTIVE')).toBe(true);
    expect((await repos.listings.findById(res.body.id))!.status).toBe('POSSIBLY_EXPIRED');
  });

  it('delivers a deferred alert on its own once quiet hours end', async () => {
    const hour = new Date().getUTCHours();
    const buyer = await signup({ timeZone: 'UTC' });
    await http().patch('/me/preferences').set(bearer(buyer.token)).send({ pushToken: 'ExpoPushToken[jobs]', quietHoursStart: hour, quietHoursEnd: (hour + 1) % 24 }).expect(200);
    await http().post('/alerts').set(bearer(buyer.token)).send({ name: 'Jobs', keywords: ['autojobword'], maxPriceMinor: 25000, currency: 'USD', radiusKm: 16, centerLat: 40.73, centerLng: -73.99 }).expect(201);
    const seller = await signup();
    const before = sent.length;
    await http().post('/listings').set(bearer(seller.token)).send({ title: `autojobword lamp ${uniq()}`, description: 'x', categoryKey: 'furniture', condition: 'GOOD', price: '20', currency: 'USD', lat: 40.733, lng: -73.99, locationLabel: 'NY' }).expect(201);
    expect(sent.length).toBe(before); // held back by quiet hours
    await http().patch('/me/preferences').set(bearer(buyer.token)).send({ quietHoursStart: (hour + 5) % 24, quietHoursEnd: (hour + 6) % 24 }).expect(200);
    expect(await until(() => sent.length === before + 1)).toBe(true); // no admin call anywhere in this test
    await sleep(1200); // later runs must not send it again
    expect(sent.length).toBe(before + 1);
  });

  it('reports job health to admins and can queue an extra run', async () => {
    const admin = await signup();
    await repos.users.update(admin.id, { role: 'ADMIN' });
    const status = await http().get('/admin/jobs/status').set(bearer(admin.token)).expect(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.jobs.map((j: { name: string }) => j.name)).toEqual(expect.arrayContaining(['expire-listings', 'dispatch-alerts', 'purge-expired-tokens']));
    expect(await until(async () => (await http().get('/admin/jobs/status').set(bearer(admin.token))).body.jobs.every((j: { lastSuccess: unknown }) => j.lastSuccess))).toBe(true);
    const q = await http().post('/admin/jobs/queue/expire-listings').set(bearer(admin.token)).expect(201);
    expect(q.body).toHaveProperty('jobId');
    expect((await http().post('/admin/jobs/queue/no-such-job').set(bearer(admin.token))).status).toBe(404);
    const plain = await signup();
    expect((await http().get('/admin/jobs/status').set(bearer(plain.token))).status).toBe(403);
  });
});
