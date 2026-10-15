import './env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';

/** A stand-in for Flutterwave's API: real HTTP, behaviour controlled per test. */
const fw = {
  calls: [] as { method: string; path: string; body: any; auth: string | undefined }[],
  verify: { status: 'successful', amount: 3.99, currency: 'USD' } as Record<string, any>,
  ids: new Map<string, number>(),
  subscriptions: [{ id: 77, status: 'active', plan: '222' }] as any[],
  failPayments: false,
  failCancel: false,
  refundStatus: 'completed',
};
const HASH = 'test-secret-hash-0123456789';
let server: Server;

function start(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url!, 'http://x');
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        fw.calls.push({ method: req.method!, path: u.pathname + u.search, body, auth: req.headers.authorization });
        const send = (code: number, json: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(json)); };
        if (u.pathname === '/v3/payments' && req.method === 'POST') return fw.failPayments ? send(500, {}) : send(200, { status: 'success', data: { link: `https://checkout.flutterwave.test/pay/${body.tx_ref}` } });
        if (u.pathname === '/v3/transactions/verify_by_reference') { const ref = u.searchParams.get('tx_ref')!; if (!fw.ids.has(ref)) fw.ids.set(ref, 700000 + fw.ids.size); return send(200, { status: 'success', data: { id: fw.ids.get(ref), ...fw.verify, tx_ref: ref, customer: { email: 'x@y.z' } } }); }
        if (u.pathname === '/v3/subscriptions' && req.method === 'GET') return send(200, { status: 'success', data: fw.subscriptions });
        if (/^\/v3\/subscriptions\/\d+\/cancel$/.test(u.pathname)) return fw.failCancel ? send(500, {}) : send(200, { status: 'success', data: { status: 'cancelled' } });
        if (/^\/v3\/transactions\/\d+\/refund$/.test(u.pathname)) return send(200, { status: 'success', data: { id: 555, status: fw.refundStatus } });
        send(404, { status: 'error', message: 'nope' });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.env.BILLING_PROVIDER = 'flutterwave';
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST-abc';
      process.env.FLUTTERWAVE_SECRET_HASH = HASH;
      process.env.FLUTTERWAVE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.PREMIUM_MONTHLY_PRICES = 'NGN:1500,USD:3.99';
      process.env.FLUTTERWAVE_PREMIUM_MONTHLY_PLAN_IDS = 'NGN:111,USD:222';
      process.env.BILLING_GRACE_DAYS = '3';
      resolve();
    });
  });
}

let n = 0;
const uniq = () => `${Date.now()}${++n}`;
const DAY = 86_400_000;

describe('billing (Flutterwave adapter, local stand-in server)', () => {
  let app: INestApplication;
  let repos: import('../src/domain/ports').Repos;
  let svc: import('../src/billing/billing').BillingService;
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    await start();
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/main');
    const { REPOS } = await import('../src/domain/ports');
    const { BillingService } = await import('../src/billing/billing');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    repos = app.get(REPOS);
    svc = app.get(BillingService);
  });
  afterAll(async () => { await app?.close(); server?.close(); });
  beforeEach(() => { fw.calls = []; fw.verify = { status: 'successful', amount: 3.99, currency: 'USD' }; fw.failPayments = false; fw.failCancel = false; fw.refundStatus = 'completed'; fw.subscriptions = [{ id: 77, status: 'active', plan: '222' }]; });

  async function signup(country = 'US') {
    const email = `b${uniq()}@example.com`;
    const r = await http().post('/auth/register').send({ email, password: 'correct-horse-battery', displayName: 'Payer', countryCode: country }).expect(201);
    return { token: r.body.accessToken as string, id: r.body.user.id as string, email };
  }
  const tierOf = async (id: string) => (await repos.users.findById(id))!.tier;
  const hook = (body: unknown, headers: Record<string, string> = { 'verif-hash': HASH }) => http().post('/billing/webhook/flutterwave').set({ 'content-type': 'application/json', ...headers }).send(JSON.stringify(body));
  let txId = 5000;
  const charge = (reference: string, over: Record<string, any> = {}) => ({ event: 'charge.completed', data: { id: ++txId, tx_ref: reference, amount: 3.99, currency: 'USD', status: 'successful', customer: { email: 'unused' }, ...over } });
  const checkout = (u: { token: string }, body: Record<string, unknown> = {}) => http().post('/billing/checkout').set(bearer(u.token)).send({ planKey: 'premium_monthly', ...body });
  async function subscribe(u: { token: string; id: string; email: string }) {
    const c = await checkout(u).expect(201);
    await hook(charge(c.body.reference, { customer: { email: u.email } })).expect(200);
    return c.body.reference as string;
  }

  describe('plans and checkout', () => {
    it('lists the plan with prices in minor units and a label, and blocks the iPhone app by default', async () => {
      const u = await signup();
      const r = (await http().get('/billing/plans').set(bearer(u.token)).expect(200)).body;
      expect(r).toMatchObject({ available: true, checkoutAllowed: true, plans: [{ key: 'premium_monthly', prices: expect.arrayContaining([{ currency: 'USD', minor: 399, label: '$3.99' }]), defaultCurrency: 'USD' }] });
      const ios = (await http().get('/billing/plans').query({ platform: 'ios' }).set(bearer(u.token))).body;
      expect(ios.checkoutAllowed).toBe(false);
      expect((await checkout(u, { platform: 'ios' })).status).toBe(403);
      expect((await http().get('/billing/plans')).status).toBe(401);
    });

    it('creates a pending payment and sends the provider the right amount, plan and reference', async () => {
      const u = await signup();
      const r = await checkout(u).expect(201);
      expect(r.body).toMatchObject({ checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.flutterwave\.test\/pay\/fr_/), currency: 'USD', amount: '$3.99' });
      const call = fw.calls.find((c) => c.path === '/v3/payments')!;
      expect(call.auth).toBe('Bearer FLWSECK_TEST-abc');
      expect(call.body).toMatchObject({ tx_ref: r.body.reference, amount: 3.99, currency: 'USD', payment_plan: '222', customer: { email: u.email } });
      expect((await repos.billing.findPayment(r.body.reference))).toMatchObject({ status: 'PENDING', amountMinor: 399, userId: u.id });
      expect(await tierOf(u.id)).toBe('FREE'); // starting a checkout grants nothing
    });

    it('uses the buyer\'s own currency when the plan has a price for it', async () => {
      const { CountriesService } = await import('../src/countries/countries.service');
      const admin = await signup();
      await repos.users.update(admin.id, { role: 'ADMIN' });
      await app.get(CountriesService).setEnabled(admin.id, 'NG', true);
      const u = await signup('NG');
      const r = await checkout(u).expect(201);
      expect(r.body.currency).toBe('NGN');
      expect(fw.calls.find((c) => c.path === '/v3/payments')!.body).toMatchObject({ amount: 1500, currency: 'NGN', payment_plan: '111' });
    });

    it('reports a provider outage honestly and leaves nothing pending', async () => {
      const u = await signup();
      fw.failPayments = true;
      const r = await checkout(u);
      expect(r.status).toBe(502);
      const { items } = await repos.billing.listPayments({ userId: u.id, offset: 0, limit: 5 });
      expect(items[0].status).toBe('FAILED');
    });

    it('rejects unknown plans and currencies the plan does not price', async () => {
      const u = await signup();
      expect((await checkout(u, { planKey: 'gold' })).status).toBe(404);
      expect((await checkout(u, { currency: 'EUR' })).status).toBe(400);
    });
  });

  describe('webhook authentication', () => {
    it('rejects a missing or wrong secret hash and unknown providers, and records nothing', async () => {
      const body = charge('fr_whatever');
      expect((await hook(body, {})).status).toBe(401);
      expect((await hook(body, { 'verif-hash': 'wrong' })).status).toBe(401);
      expect((await http().post('/billing/webhook/stripe').set({ 'verif-hash': HASH, 'content-type': 'application/json' }).send('{}')).status).toBe(404);
      const events = await repos.billing.listEvents({ limit: 500 });
      expect(events.some((e) => e.eventKey === `charge.completed:${txId}`)).toBe(false);
    });
    it('rejects an authenticated but malformed body', async () => {
      expect((await hook({ event: 'charge.completed', data: { id: 1 } })).status).toBe(400);
      expect((await http().post('/billing/webhook/flutterwave').set({ 'verif-hash': HASH, 'content-type': 'application/json' }).send('not json')).status).toBe(400);
    });
  });

  describe('payment events', () => {
    it('grants premium on a successful charge, for a month, exactly once', async () => {
      const u = await signup();
      const ref = await subscribe(u);
      expect(await tierOf(u.id)).toBe('PREMIUM');
      const sub = (await repos.billing.getSubscription(u.id))!;
      expect(sub).toMatchObject({ status: 'ACTIVE', tier: 'PREMIUM', planKey: 'premium_monthly', cancelAtPeriodEnd: false });
      const days = (sub.currentPeriodEnd!.getTime() - Date.now()) / DAY;
      expect(days).toBeGreaterThan(27); expect(days).toBeLessThan(32);
      expect((await repos.billing.findPayment(ref))).toMatchObject({ status: 'SUCCEEDED', providerPaymentRef: expect.any(String) });
      expect((await http().get('/me').set(bearer(u.token))).body.tier).toBe('PREMIUM');
    });

    it('ignores a duplicate delivery of the same event', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      const ev = charge(c.body.reference, { customer: { email: u.email } });
      expect((await hook(ev).expect(200)).body).toMatchObject({ duplicate: false });
      const end = (await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime();
      expect((await hook(ev).expect(200)).body).toMatchObject({ duplicate: true });
      expect((await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime()).toBe(end);
      expect((await repos.billing.listPayments({ userId: u.id, offset: 0, limit: 10 })).total).toBe(1);
    });

    it('does not double-grant when the same charge arrives under another event id, or via the app\'s own verify call', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      const first = charge(c.body.reference, { customer: { email: u.email } });
      await hook(first).expect(200);
      const end = (await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime();
      await hook({ ...first, data: { ...first.data, id: first.data.id + 100000 } }).expect(200); // new event key, same tx_ref
      fw.verify = { status: 'successful', id: first.data.id, amount: 3.99, currency: 'USD' };
      await http().post('/billing/verify').set(bearer(u.token)).send({ reference: c.body.reference }).expect(201);
      expect((await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime()).toBe(end);
    });

    it('never grants access for the wrong amount', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      await hook(charge(c.body.reference, { amount: 1.0, customer: { email: u.email } })).expect(200);
      expect(await tierOf(u.id)).toBe('FREE');
      expect((await repos.billing.findPayment(c.body.reference))).toMatchObject({ status: 'FAILED', failureReason: 'AMOUNT_MISMATCH' });
    });

    it('never grants access for the wrong currency', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      await hook(charge(c.body.reference, { currency: 'NGN', amount: 3.99, customer: { email: u.email } })).expect(200);
      expect(await tierOf(u.id)).toBe('FREE');
    });

    it('records a failed charge without granting anything', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      await hook(charge(c.body.reference, { status: 'failed', customer: { email: u.email } })).expect(200);
      expect(await tierOf(u.id)).toBe('FREE');
      expect((await repos.billing.findPayment(c.body.reference))!.status).toBe('FAILED');
    });

    it('a late success after a failure still counts (the customer retried and paid)', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      await hook(charge(c.body.reference, { status: 'failed', customer: { email: u.email } })).expect(200);
      await hook(charge(c.body.reference, { customer: { email: u.email } })).expect(200);
      expect(await tierOf(u.id)).toBe('PREMIUM');
    });

    it('stores unrecognised events without acting on them', async () => {
      const r = await hook({ event: 'transfer.completed', data: { id: 424242 } }).expect(200);
      expect(r.body.received).toBe(true);
      expect((await repos.billing.listEvents({ limit: 500 })).find((e) => e.eventKey === 'transfer.completed:424242')!.status).toBe('IGNORED');
    });

    it('a processing failure returns an error so the provider retries, and the retry succeeds', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      const ev = charge(c.body.reference, { customer: { email: u.email } });
      const spy = jest.spyOn(repos.billing, 'saveSubscription').mockRejectedValueOnce(new Error('database blip'));
      expect((await hook(ev)).status).toBe(500);
      spy.mockRestore();
      expect((await repos.billing.listEvents({ status: 'FAILED', limit: 50 })).some((e) => e.eventKey === `charge.completed:${ev.data.id}` && /database blip/.test(e.error ?? ''))).toBe(true);
      expect((await hook(ev).expect(200)).body.duplicate).toBe(false);
      expect((await repos.billing.findPayment(c.body.reference))!.status).toBe('SUCCEEDED');
      expect(await tierOf(u.id)).toBe('PREMIUM'); // paid and granted, not paid and forgotten
    });
  });

  describe('confirming without the webhook', () => {
    it('verifies with the provider when the person returns to the app', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      const r = await http().post('/billing/verify').set(bearer(u.token)).send({ reference: c.body.reference }).expect(201);
      expect(r.body).toMatchObject({ status: 'SUCCEEDED', tier: 'PREMIUM' });
      expect(fw.calls.some((x) => x.path.startsWith('/v3/transactions/verify_by_reference?tx_ref=' + c.body.reference))).toBe(true);
    });
    it('stays pending while the provider says pending, and only the owner can ask', async () => {
      const u = await signup(); const other = await signup();
      const c = await checkout(u).expect(201);
      fw.verify = { status: 'pending', id: 1, amount: 3.99, currency: 'USD' };
      expect((await http().post('/billing/verify').set(bearer(u.token)).send({ reference: c.body.reference }).expect(201)).body).toMatchObject({ status: 'PENDING', tier: 'FREE' });
      expect((await http().post('/billing/verify').set(bearer(other.token)).send({ reference: c.body.reference })).status).toBe(404);
    });
    it('does not trust a provider answer with the wrong amount', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      fw.verify = { status: 'successful', id: 31, amount: 0.5, currency: 'USD' };
      expect((await http().post('/billing/verify').set(bearer(u.token)).send({ reference: c.body.reference }).expect(201)).body.tier).toBe('FREE');
    });
  });

  describe('subscription lifecycle', () => {
    it('refuses a second checkout while subscribed', async () => {
      const u = await signup();
      await subscribe(u);
      expect((await checkout(u)).status).toBe(409);
    });

    it('extends access on a renewal charge, ignores wrong amounts and strangers', async () => {
      const u = await signup();
      await subscribe(u);
      const before = (await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime();
      await hook(charge('FLW-renewal-1', { customer: { email: u.email } })).expect(200);
      const after = (await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime();
      expect((after - before) / DAY).toBeGreaterThan(27);
      await hook(charge('FLW-renewal-2', { amount: 0.01, customer: { email: u.email } })).expect(200);
      await hook(charge('FLW-renewal-3', { customer: { email: 'nobody@example.com' } })).expect(200);
      expect((await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime()).toBe(after);
      expect((await repos.billing.listPayments({ userId: u.id, offset: 0, limit: 10 })).total).toBe(2);
    });

    it('a failed renewal keeps access during the grace period, then removes it', async () => {
      const u = await signup();
      await subscribe(u);
      await hook(charge('FLW-renewal-fail', { status: 'failed', customer: { email: u.email } })).expect(200);
      expect((await repos.billing.getSubscription(u.id))!.status).toBe('PAST_DUE');
      const end = (await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime();
      await svc.reconcile(new Date(end + 2 * DAY));
      expect(await tierOf(u.id)).toBe('PREMIUM');
      await svc.reconcile(new Date(end + 4 * DAY));
      expect(await tierOf(u.id)).toBe('FREE');
    });

    it('cancellation at the provider keeps access until the paid period ends', async () => {
      const u = await signup();
      await subscribe(u);
      await hook({ event: 'subscription.cancelled', data: { id: 321, customer: { email: u.email }, plan: { id: 222 } } }).expect(200);
      expect((await repos.billing.getSubscription(u.id))).toMatchObject({ status: 'CANCELLED', cancelAtPeriodEnd: true });
      expect(await tierOf(u.id)).toBe('PREMIUM');
      const end = (await repos.billing.getSubscription(u.id))!.currentPeriodEnd!.getTime();
      await svc.reconcile(new Date(end + 1000));
      expect(await tierOf(u.id)).toBe('FREE');
    });

    it('a person cancelling keeps access to the end, and the provider is told', async () => {
      const u = await signup();
      await subscribe(u);
      const r = await http().post('/billing/cancel').set(bearer(u.token)).expect(201);
      expect(r.body.subscription).toMatchObject({ cancelAtPeriodEnd: true, active: true });
      expect(fw.calls.some((c) => c.method === 'GET' && c.path.startsWith('/v3/subscriptions?email='))).toBe(true);
      expect(fw.calls.some((c) => c.method === 'PUT' && c.path === '/v3/subscriptions/77/cancel')).toBe(true);
      expect(await tierOf(u.id)).toBe('PREMIUM');
      await checkout(u).expect(201); // may resubscribe once not renewing
    });

    it('does not pretend to cancel when the provider cannot be reached', async () => {
      const u = await signup();
      await subscribe(u);
      fw.failCancel = true;
      expect((await http().post('/billing/cancel').set(bearer(u.token))).status).toBe(502);
      expect((await repos.billing.getSubscription(u.id))!.cancelAtPeriodEnd).toBe(false);
    });

    it('cancel with nothing to cancel is a clear error', async () => {
      const u = await signup();
      expect((await http().post('/billing/cancel').set(bearer(u.token))).status).toBe(400);
    });

    it('shows status with recent payments', async () => {
      const u = await signup();
      await subscribe(u);
      const s = (await http().get('/billing/status').set(bearer(u.token)).expect(200)).body;
      expect(s).toMatchObject({ tier: 'PREMIUM', subscription: { status: 'ACTIVE', active: true }, payments: [{ status: 'SUCCEEDED', amount: '$3.99' }] });
    });

    it('premium unlocks the higher alert limit', async () => {
      const u = await signup();
      const mk = (i: number) => http().post('/alerts').set(bearer(u.token)).send({ name: `A${i}`, keywords: [`kw${i}`], currency: 'USD', radiusKm: 10, centerLat: 40.7, centerLng: -74 });
      for (let i = 0; i < 3; i++) await mk(i).expect(201);
      expect((await mk(3)).status).toBeGreaterThanOrEqual(400);
      await subscribe(u);
      await mk(4).expect(201);
    });
  });

  describe('reconcile (lost webhooks)', () => {
    it('confirms an old pending checkout with the provider', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      const p = (await repos.billing.findPayment(c.body.reference))!;
      await repos.billing.transitionPayment(p.id, ['PENDING'], { createdAt: new Date(Date.now() - 2 * 3_600_000) });
      const r = await svc.reconcile();
      expect(r.confirmed).toBeGreaterThanOrEqual(1);
      expect(await tierOf(u.id)).toBe('PREMIUM');
    });
    it('abandons checkouts that were never paid after a day', async () => {
      const u = await signup();
      const c = await checkout(u).expect(201);
      const p = (await repos.billing.findPayment(c.body.reference))!;
      await repos.billing.transitionPayment(p.id, ['PENDING'], { createdAt: new Date(Date.now() - 30 * 3_600_000) });
      fw.verify = { status: 'pending', id: 1, amount: 3.99, currency: 'USD' };
      await svc.reconcile();
      expect((await repos.billing.findPayment(c.body.reference))!.status).toBe('ABANDONED');
      expect(await tierOf(u.id)).toBe('FREE');
    });
    it('is registered as a scheduled job', () => {
      const { JobsService } = require('../src/jobs/jobs.service');
      expect((app.get(JobsService) as any).extra.map((d: any) => d.name)).toContain('billing-reconcile');
    });
  });

  describe('refunds', () => {
    async function admin() {
      const a = await signup();
      await repos.users.update(a.id, { role: 'ADMIN' });
      return a;
    }
    it('are admin only', async () => {
      const u = await signup();
      const ref = await subscribe(u);
      expect((await http().post('/admin/billing/refund').set(bearer(u.token)).send({ reference: ref, reason: 'please' })).status).toBe(403);
    });
    it('a full refund ends premium at once, stops future billing and is audited', async () => {
      const a = await admin(); const u = await signup();
      const ref = await subscribe(u);
      const r = await http().post('/admin/billing/refund').set(bearer(a.token)).send({ reference: ref, reason: 'Customer request' }).expect(201);
      expect(r.body.status).toBe('REFUNDED');
      expect(fw.calls.some((c) => /\/v3\/transactions\/\d+\/refund$/.test(c.path))).toBe(true);
      expect(fw.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/cancel'))).toBe(true);
      expect(await tierOf(u.id)).toBe('FREE');
      expect(JSON.stringify((await http().get('/admin/audit').set(bearer(a.token))).body)).toContain('PAYMENT_REFUND');
      expect((await http().post('/admin/billing/refund').set(bearer(a.token)).send({ reference: ref, reason: 'again' })).status).toBe(400);
    });
    it('a partial refund keeps premium and only allows what is left', async () => {
      const a = await admin(); const u = await signup();
      const ref = await subscribe(u);
      expect((await http().post('/admin/billing/refund').set(bearer(a.token)).send({ reference: ref, amount: '5.00', reason: 'too much' })).status).toBe(400);
      const r = await http().post('/admin/billing/refund').set(bearer(a.token)).send({ reference: ref, amount: '1.00', reason: 'goodwill' }).expect(201);
      expect(r.body.status).toBe('PARTIALLY_REFUNDED');
      expect(await tierOf(u.id)).toBe('PREMIUM');
      expect((await repos.billing.findPayment(ref))!.refundedMinor).toBe(100);
    });
    it('a refund the provider has not finished is pending until an admin settles it', async () => {
      const a = await admin(); const u = await signup();
      const ref = await subscribe(u);
      fw.refundStatus = 'pending';
      expect((await http().post('/admin/billing/refund').set(bearer(a.token)).send({ reference: ref, reason: 'dispute' }).expect(201)).body.status).toBe('REFUND_PENDING');
      expect(await tierOf(u.id)).toBe('FREE');
      await http().post(`/admin/billing/refunds/${ref}/settle`).set(bearer(a.token)).send({ note: 'Confirmed on dashboard' }).expect(201);
      expect((await repos.billing.findPayment(ref))!.status).toBe('REFUNDED');
    });
    it('cannot refund a payment that did not succeed', async () => {
      const a = await admin(); const u = await signup();
      const c = await checkout(u).expect(201);
      expect((await http().post('/admin/billing/refund').set(bearer(a.token)).send({ reference: c.body.reference, reason: 'no' })).status).toBe(400);
    });
    it('admins can list payments and events; others cannot', async () => {
      const a = await admin(); const u = await signup();
      expect((await http().get('/admin/billing/payments').set(bearer(a.token)).expect(200)).body.total).toBeGreaterThan(0);
      expect((await http().get('/admin/billing/events').set(bearer(a.token)).expect(200)).body.items.length).toBeGreaterThan(0);
      expect((await http().get('/admin/billing/events').set(bearer(u.token))).status).toBe(403);
    });
  });
});
