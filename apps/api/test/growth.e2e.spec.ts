import './env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ClaimsService } from '../src/claims/claims';
import { PUSH_SENDER, PushMessage, REPOS, Repos } from '../src/domain/ports';
import { ListingsService } from '../src/listings/listings';
import { configureApp } from '../src/main';

let n = 0;
const uniq = () => `${Date.now()}${++n}`;
// Far-apart coordinates so the duplicate detector never links two test listings.
let spot = 0;
const place = () => ({ lat: 10 + (spot++ % 70) * 1.1, lng: -170 + Math.floor(spot / 70) * 3 + (spot % 70) * 0.01 });

describe('growth features: reservations, curb finds, share pages, referrals, organisations', () => {
  let app: INestApplication;
  let repos: Repos;
  const pushed: PushMessage[] = [];
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  type U = { token: string; id: string; email: string };

  beforeAll(async () => {
    const push = { isConfigured: () => true, send: async (m: PushMessage) => { pushed.push(m); return { sent: true }; } };
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PUSH_SENDER).useValue(push).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    repos = app.get<Repos>(REPOS);
  });
  afterAll(() => app?.close());

  async function signup(name = 'Person', extra: Record<string, unknown> = {}): Promise<U> {
    const r = await http().post('/auth/register').send({ email: `g${uniq()}@example.com`, password: 'correct-horse-battery', displayName: name, ...extra }).expect(201);
    return { token: r.body.accessToken, id: r.body.user.id, email: r.body.user.email };
  }
  async function admin(): Promise<U> {
    const a = await signup('Admin');
    await repos.users.update(a.id, { role: 'ADMIN' });
    return a;
  }
  async function give(seller: U, price: string | undefined = '0', extra: Record<string, unknown> = {}) {
    const r = await http().post('/listings').set(bearer(seller.token)).send({ title: `Sofa ${uniq()}`, description: 'Comfortable', categoryKey: 'furniture', condition: 'GOOD', ...(price === undefined ? {} : { price }), currency: 'USD', ...place(), locationLabel: 'Leeds', ...extra }).expect(201);
    return r.body.id as string;
  }
  const claim = (u: U, listingId: string) => http().post(`/listings/${listingId}/claims`).set(bearer(u.token));
  const act = (u: U, claimId: string, what: 'confirm' | 'collected' | 'no-show' | 'cancel') => http().post(`/claims/${claimId}/${what}`).set(bearer(u.token));
  const spotted = (u: U, extra: Record<string, unknown> = {}) =>
    http().post('/listings/spotted').set(bearer(u.token)).send({ title: `Curb chair ${uniq()}`, ...place(), locationLabel: 'Elm Street', imageUrls: ['https://cdn.example.com/chair.jpg'], ...extra });

  // ------------------------------------------------------------------ quick post defaults
  describe('quick post', () => {
    it('needs only a title, a location and a free/paid choice: category, condition and currency default sensibly', async () => {
      const u = await signup();
      const r = await http().post('/listings').set(bearer(u.token)).send({ title: `Quick ${uniq()}`, price: '0', ...place() }).expect(201);
      expect(r.body).toMatchObject({ category: 'other', condition: 'UNKNOWN', price: { currency: 'USD', isFree: true }, kind: 'GIVEN', claimable: true, reserved: false });
    });
  });

  // ------------------------------------------------------------------ reservations
  describe('reservations ("I\'ll take it")', () => {
    it('lets one person reserve a free item and shows it as reserved to everyone', async () => {
      const giver = await signup('Gina Giver'); const a = await signup('Alex'); const b = await signup('Bo');
      const id = await give(giver);
      pushed.length = 0;
      await repos.users.update(giver.id, { prefs: { ...(await repos.users.findById(giver.id))!.prefs, pushEnabled: true, pushToken: 'ExpoPushToken[giver]' } });
      const c = await claim(a, id).expect(201);
      expect(c.body).toMatchObject({ role: 'CLAIMER', status: 'HELD', actions: { cancel: true, confirm: false, collected: false } });
      expect(new Date(c.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(110 * 60_000); // two-hour hold
      expect(pushed.at(-1)).toMatchObject({ title: 'Someone wants your item' });
      expect(JSON.stringify(pushed.at(-1))).not.toContain('Alex');

      const search = (await http().get('/listings')).body.items.find((i: any) => i.id === id);
      expect(search.reserved).toBe(true);
      expect((await http().get(`/listings/${id}`)).body.reserved).toBe(true);

      const second = await claim(b, id);
      expect(second.status).toBe(409);
      expect(second.body.message).toMatch(/already reserved/i);

      const forGiver = (await http().get(`/listings/${id}/claim`).set(bearer(giver.token)).expect(200)).body;
      expect(forGiver.forGiver).toMatchObject({ role: 'GIVER', other: { displayName: 'Alex' }, claimerReliability: { label: 'NEW', text: 'New to collecting' } });
      const forBob = (await http().get(`/listings/${id}/claim`).set(bearer(b.token)).expect(200)).body;
      expect(forBob).toMatchObject({ reserved: true, mine: null, forGiver: null });
      expect(JSON.stringify(forBob)).not.toContain('Alex');
    });

    it('lets exactly one of many simultaneous taps win', async () => {
      const giver = await signup(); const people = await Promise.all([1, 2, 3, 4, 5, 6].map(() => signup()));
      const id = await give(giver);
      const results = await Promise.all(people.map((p) => claim(p, id)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    });

    it('refuses items that are paid, your own, spotted, from outside, or when you hold too many', async () => {
      const giver = await signup(); const a = await signup();
      expect((await claim(a, await give(giver, '25'))).status).toBe(400); // paid
      expect((await claim(giver, await give(giver))).status).toBe(400); // own
      const s = (await spotted(giver).expect(201)).body.id;
      expect((await claim(a, s)).status).toBe(400); // spotted: the poster is not the giver
      expect((await claim(a, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
      for (let i = 0; i < 3; i++) await claim(a, await give(giver)).expect(201);
      const over = await claim(a, await give(giver));
      expect(over.status).toBe(409);
      expect(over.body.message).toMatch(/3 active reservations/);
    });

    it('treats a block in either direction as if the listing does not exist', async () => {
      const giver = await signup(); const a = await signup();
      const id = await give(giver);
      await repos.blocks.add(giver.id, a.id);
      expect((await claim(a, id)).status).toBe(404);
    });

    it('lets only the giver confirm, and gives the collector a day to pick up', async () => {
      const giver = await signup(); const a = await signup();
      const id = await give(giver);
      const c = (await claim(a, id).expect(201)).body;
      expect((await act(a, c.id, 'confirm')).status).toBe(403);
      const confirmed = (await act(giver, c.id, 'confirm').expect(201)).body;
      expect(confirmed).toMatchObject({ status: 'CONFIRMED', actions: { confirm: false, collected: true, cancel: true } });
      expect(new Date(confirmed.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
      expect((await act(giver, c.id, 'confirm')).status).toBe(409); // not twice
    });

    it('closes the listing when the giver marks it collected, and records the item given', async () => {
      const giver = await signup(); const a = await signup();
      const id = await give(giver);
      const c = (await claim(a, id).expect(201)).body;
      expect((await act(a, c.id, 'collected')).status).toBe(403);
      await act(giver, c.id, 'collected').expect(201);
      expect((await http().get(`/listings/${id}`)).status).toBe(404); // no longer public
      expect((await repos.claims.tally(giver.id)).given).toBe(1);
      expect((await repos.claims.tally(a.id)).collected).toBe(1);
      expect((await act(giver, c.id, 'collected')).status).toBe(409);
    });

    it('releases the item when the collector cancels, and counts it against them only after the giver confirmed', async () => {
      const giver = await signup(); const a = await signup(); const b = await signup();
      const id = await give(giver);
      const early = (await claim(a, id).expect(201)).body;
      await act(a, early.id, 'cancel').expect(201);
      expect((await repos.claims.tally(a.id)).lateCancel).toBe(0); // before confirmation: no mark
      const c = (await claim(b, id).expect(201)).body; // free again
      await act(giver, c.id, 'confirm').expect(201);
      await act(b, c.id, 'cancel').expect(201);
      expect((await repos.claims.tally(b.id)).lateCancel).toBe(1);
      await claim(a, id).expect(201); // and free again
    });

    it('does not mark the collector when the giver cancels', async () => {
      const giver = await signup(); const a = await signup();
      const id = await give(giver);
      const c = (await claim(a, id).expect(201)).body;
      await act(giver, c.id, 'confirm').expect(201);
      await act(giver, c.id, 'cancel').expect(201);
      expect(await repos.claims.tally(a.id)).toMatchObject({ lateCancel: 0, noShow: 0 });
    });

    it('lets a giver report a no-show only after waiting, and the item stays available', async () => {
      const giver = await signup(); const a = await signup(); const b = await signup();
      const id = await give(giver);
      const c = (await claim(a, id).expect(201)).body;
      expect((await act(giver, c.id, 'no-show')).status).toBe(409); // still only held
      await act(giver, c.id, 'confirm').expect(201);
      const early = await act(giver, c.id, 'no-show');
      expect(early.status).toBe(409);
      expect(early.body.message).toMatch(/longer/i);
      await repos.claims.transition(c.id, ['CONFIRMED'], { confirmedAt: new Date(Date.now() - 31 * 60_000) });
      expect((await act(a, c.id, 'no-show')).status).toBe(403);
      await act(giver, c.id, 'no-show').expect(201);
      expect((await repos.claims.tally(a.id)).noShow).toBe(1);
      expect((await http().get(`/listings/${id}`)).status).toBe(200);
      await claim(b, id).expect(201);
    });

    it('lapses unconfirmed holds and missed pickups without blaming anyone', async () => {
      const giver = await signup(); const a = await signup(); const b = await signup();
      const held = await give(giver); const picked = await give(giver);
      const h = (await claim(a, held).expect(201)).body;
      const p = (await claim(b, picked).expect(201)).body;
      await act(giver, p.id, 'confirm').expect(201);
      const svc = app.get(ClaimsService);
      expect(await svc.expireDue(new Date(Date.now() + 3 * 3_600_000))).toMatchObject({ expired: expect.any(Number) }); // hold lapses, pickup still open
      expect((await repos.claims.findById(h.id))!.status).toBe('EXPIRED');
      expect((await repos.claims.findById(p.id))!.status).toBe('CONFIRMED');
      await svc.expireDue(new Date(Date.now() + 26 * 3_600_000));
      expect((await repos.claims.findById(p.id))!.status).toBe('EXPIRED');
      expect(await repos.claims.tally(a.id)).toMatchObject({ collected: 0, noShow: 0, lateCancel: 0 });
      expect(await repos.claims.tally(b.id)).toMatchObject({ collected: 0, noShow: 0, lateCancel: 0 });
      await claim(a, held).expect(201); // free to reserve again
    });

    it('releases a reservation when the item is withdrawn', async () => {
      const giver = await signup(); const a = await signup();
      const id = await give(giver);
      const c = (await claim(a, id).expect(201)).body;
      await http().post(`/listings/${id}/unavailable`).set(bearer(giver.token)).expect(201);
      await app.get(ClaimsService).expireDue();
      const mine = (await http().get('/claims/mine').set(bearer(a.token)).expect(200)).body;
      expect(mine.asClaimer.find((x: any) => x.id === c.id)).toMatchObject({ status: 'CANCELLED', expiresAt: null });
    });

    it('shows a reliability label to the giver only after a few clear outcomes', async () => {
      const giver = await signup(); const a = await signup();
      for (let i = 0; i < 3; i++) {
        const c = (await claim(a, await give(giver)).expect(201)).body;
        await act(giver, c.id, 'collected').expect(201);
      }
      const id = await give(giver);
      await claim(a, id).expect(201);
      const view = (await http().get(`/listings/${id}/claim`).set(bearer(giver.token)).expect(200)).body.forGiver;
      expect(view.claimerReliability).toMatchObject({ label: 'RELIABLE', text: 'Collected 3 of 3 reserved items', rate: 1 });
      // The collector never sees anyone's score, and the listing page shows the giver's record.
      expect(JSON.stringify((await http().get('/claims/mine').set(bearer(a.token))).body.asClaimer)).not.toContain('claimerReliability');
      expect((await http().get(`/listings/${id}`)).body.giver).toEqual({ itemsGiven: 3 });
    });

    it('needs a signed-in user', async () => {
      expect((await http().post('/listings/x/claims')).status).toBe(401);
      expect((await http().get('/claims/mine')).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------ spotted
  describe('spotted free items', () => {
    it('creates a free, photo-backed, short-lived find that nobody can message or reserve', async () => {
      const u = await signup();
      const r = (await spotted(u).expect(201)).body;
      expect(r).toMatchObject({ kind: 'SPOTTED', claimable: false, messageable: false, price: { isFree: true }, source: { name: 'Spotted by a member' }, condition: 'UNKNOWN' });
      const ttl = new Date(r.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(23 * 3_600_000);
      expect(ttl).toBeLessThanOrEqual(24 * 3_600_000 + 5000);
      const stranger = await signup();
      expect((await http().post(`/listings/${r.id}/conversations`).set(bearer(stranger.token)).send({ message: 'hi' })).status).toBe(400);
    });

    it('insists on a photo and a sensible shape', async () => {
      const u = await signup();
      expect((await spotted(u, { imageUrls: [] })).status).toBe(400);
      expect((await spotted(u, { imageUrls: undefined })).status).toBe(400);
      expect((await spotted(u, { price: '5' })).status).toBe(400); // price is not a spotted field
      expect((await spotted(u, { imageUrls: ['a', 'b', 'c', 'd', 'e'].map((x) => `https://cdn.example.com/${x}.jpg`) })).status).toBe(400);
    });

    it('caps how many finds one person can report in a day', async () => {
      const u = await signup();
      for (let i = 0; i < 10; i++) await spotted(u).expect(201);
      const over = await spotted(u);
      expect(over.status).toBe(429);
    });

    it('disappears completely once its day is over', async () => {
      const u = await signup();
      const r = (await spotted(u).expect(201)).body;
      await app.get(ListingsService).runExpiry(new Date(Date.now() + 25 * 3_600_000));
      expect((await http().get(`/listings/${r.id}`)).status).toBe(404);
      expect((await repos.listings.findById(r.id))!.status).toBe('REMOVED');
    });

    it('lets the finder close it at once, but needs two different people to hide someone else\'s find', async () => {
      const finder = await signup(); const a = await signup(); const b = await signup();
      const mine = (await spotted(finder).expect(201)).body.id;
      await http().post(`/listings/${mine}/gone`).set(bearer(finder.token)).expect(201);
      expect((await http().get(`/listings/${mine}`)).status).toBe(404);

      const theirs = (await spotted(finder).expect(201)).body.id;
      const one = (await http().post(`/listings/${theirs}/gone`).set(bearer(a.token)).expect(201)).body;
      expect(one).toMatchObject({ gone: false, thanks: true });
      expect((await http().get(`/listings/${theirs}`)).status).toBe(200);
      expect((await http().post(`/listings/${theirs}/gone`).set(bearer(a.token))).status).toBe(409); // not twice
      const two = (await http().post(`/listings/${theirs}/gone`).set(bearer(b.token)).expect(201)).body;
      expect(two.gone).toBe(true);
      expect((await http().get(`/listings/${theirs}`)).status).toBe(404);
    });

    it('is only for spotted items', async () => {
      const g = await signup(); const a = await signup();
      expect((await http().post(`/listings/${await give(g)}/gone`).set(bearer(a.token))).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ share pages
  describe('public share pages', () => {
    it('shows a safe preview with no coordinates, no seller identity and no markup injection', async () => {
      const seller = await signup('Sally Seller');
      const id = await give(seller, '0', { title: `<b>Desk</b> & "chair" ${uniq()}`, description: '<script>alert(1)</script> solid', imageUrls: ['https://cdn.example.com/p.jpg'] });
      const r = await http().get(`/s/${id}`).expect(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['x-robots-tag']).toMatch(/noindex/);
      const html = r.text;
      expect(html).toContain('property="og:title"');
      expect(html).toContain('&lt;b&gt;Desk&lt;/b&gt; &amp; &quot;chair&quot;');
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<b>Desk</b>');
      expect(html).toContain('property="og:image" content="https://cdn.example.com/p.jpg"');
      expect(html).toContain(`freebieradar://listing/${id}`);
      const stored = (await repos.listings.findById(id))!;
      expect(html).not.toContain(String(stored.lat));
      expect(html).not.toContain(String(stored.lng));
      expect(html).not.toContain('Sally');
      expect(html).not.toContain(seller.email);
      expect(html).toContain('Near Leeds (approximate area)');
    });

    it('marks reserved and spotted items', async () => {
      const g = await signup(); const a = await signup();
      const id = await give(g);
      await claim(a, id).expect(201);
      expect((await http().get(`/s/${id}`)).text).toContain('Reserved');
      // Plain-http photo links are refused when a listing is made, so a preview can never point at one.
      expect((await spotted(g, { imageUrls: ['http://insecure.example.com/x.jpg'] })).status).toBe(400);
      const s = (await spotted(g).expect(201)).body.id;
      const html = (await http().get(`/s/${s}`).expect(200)).text;
      expect(html).toContain('Spotted by a member');
    });

    it('treats hidden, removed and invalid listings the same as ones that never existed', async () => {
      const g = await signup();
      const id = await give(g);
      await http().post(`/listings/${id}/unavailable`).set(bearer(g.token)).expect(201);
      for (const target of [id, '00000000-0000-4000-8000-000000000000', 'not-an-id', '..%2f..%2fetc']) {
        const r = await http().get(`/s/${target}`);
        expect(r.status).toBe(404);
        expect(r.text).toContain('no longer available');
        expect(r.headers['cache-control']).toBe('no-store');
      }
    });
  });

  // ------------------------------------------------------------------ referrals
  describe('referral and ambassador codes', () => {
    it('gives every member one invite code and counts the people who join with it', async () => {
      const host = await signup('Hosty');
      const first = (await http().get('/me/referral').set(bearer(host.token)).expect(200)).body;
      expect(first.code).toMatch(/^FR[A-HJ-NP-Z2-9]{6}$/);
      expect((await http().get('/me/referral').set(bearer(host.token))).body.code).toBe(first.code); // stable
      await signup('Friend', { referralCode: first.code.toLowerCase() });
      await signup('Friend2', { referralCode: first.code });
      const stats = (await http().get('/me/referral').set(bearer(host.token)).expect(200)).body;
      expect(stats).toMatchObject({ code: first.code, signups: 2, verifiedSignups: 0 });
      const friend = await signup('Friend3', { referralCode: first.code });
      expect((await repos.users.findById(friend.id))!.referredByCode).toBe(first.code);
    });

    it('ignores unknown or switched-off codes instead of blocking sign-up', async () => {
      const a = await admin();
      const made = (await http().post('/admin/referral-codes').set(bearer(a.token)).send({ label: 'Campus ambassador Ada', code: `ada${uniq()}`.slice(0, 12) }).expect(201)).body;
      const unknown = await signup('Xavier', { referralCode: 'NOSUCHCODE' });
      expect((await repos.users.findById(unknown.id))!.referredByCode).toBeNull();
      await http().post(`/admin/referral-codes/${made.code}/active`).set(bearer(a.token)).send({ active: false }).expect(201);
      const off = await signup('Yolanda', { referralCode: made.code });
      expect((await repos.users.findById(off.id))!.referredByCode).toBeNull();
      await http().post(`/admin/referral-codes/${made.code}/active`).set(bearer(a.token)).send({ active: true }).expect(201);
      const on = await signup('Zed Z', { referralCode: made.code.toLowerCase() });
      expect((await repos.users.findById(on.id))!.referredByCode).toBe(made.code);
    });

    it('reports what an ambassador code brought in: sign-ups, verified, listings and items collected', async () => {
      const a = await admin();
      const code = (await http().post('/admin/referral-codes').set(bearer(a.token)).send({ label: 'Student rep' }).expect(201)).body.code as string;
      expect(code).toMatch(/^AM/);
      const rep1 = await signup('Rep1', { referralCode: code }); await signup('Rep2', { referralCode: code });
      await repos.users.update(rep1.id, { emailVerifiedAt: new Date() });
      const taker = await signup('Taker');
      const id = await give(rep1);
      await give(rep1);
      const c = (await claim(taker, id).expect(201)).body;
      await act(rep1, c.id, 'collected').expect(201);
      const row = (await http().get('/admin/referral-codes').set(bearer(a.token)).expect(200)).body.items.find((i: any) => i.code === code);
      expect(row).toMatchObject({ kind: 'AMBASSADOR', label: 'Student rep', active: true, stats: { signups: 2, verifiedSignups: 1, listingsPosted: 2, itemsGivenAndCollected: 1, capped: false } });
    });

    it('is admin-only and refuses duplicate codes', async () => {
      const u = await signup(); const a = await admin();
      expect((await http().get('/admin/referral-codes').set(bearer(u.token))).status).toBe(403);
      expect((await http().post('/admin/referral-codes').set(bearer(u.token)).send({ label: 'x' })).status).toBe(403);
      const code = `dup${uniq()}`.slice(0, 12);
      await http().post('/admin/referral-codes').set(bearer(a.token)).send({ label: 'One', code }).expect(201);
      expect((await http().post('/admin/referral-codes').set(bearer(a.token)).send({ label: 'Two', code: code.toUpperCase() })).status).toBe(409);
      expect((await http().post('/admin/referral-codes').set(bearer(a.token)).send({ label: 'Bad', code: 'no spaces!' })).status).toBe(400);
      expect((await http().post('/auth/register').send({ email: `r${uniq()}@example.com`, password: 'correct-horse-battery', displayName: 'Bad', referralCode: 'no spaces' })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ organisations
  describe('organisation bulk upload', () => {
    const HEADER = 'title,description,category,condition,price,currency,location_label,lat,lng,image_url,available_days';
    async function org(withHome = true): Promise<U> {
      const a = await admin(); const o = await signup('Leeds Reuse Hub');
      if (withHome) await http().patch('/me/preferences').set(bearer(o.token)).send({ homeLat: 53.8008, homeLng: -1.5491, homeLabel: 'Leeds city centre', locationPrecision: 'precise' }).expect(200);
      await http().post('/admin/organisations').set(bearer(a.token)).send({ email: o.email, enabled: true }).expect(201);
      return o;
    }
    const upload = (u: U, csv: string) => http().post('/org/listings/import').set(bearer(u.token)).send({ csv });

    it('is closed to ordinary members until an admin approves the organisation', async () => {
      const u = await signup(); const a = await admin();
      expect((await upload(u, `${HEADER}\nA,,,,0,,,,,,`)).status).toBe(403);
      expect((await http().get('/org/import/template').set(bearer(u.token))).status).toBe(403);
      expect((await http().post('/admin/organisations').set(bearer(u.token)).send({ email: u.email, enabled: true })).status).toBe(403);
      await http().post('/admin/organisations').set(bearer(a.token)).send({ email: u.email, enabled: true }).expect(201);
      expect((await repos.users.findById(u.id))!.role).toBe('BUSINESS');
      expect((await http().get('/org/import/template').set(bearer(u.token)).expect(200)).body.columns).toContain('title');
      await http().post('/admin/organisations').set(bearer(a.token)).send({ email: u.email, enabled: false }).expect(201);
      expect((await repos.users.findById(u.id))!.role).toBe('USER');
      expect((await upload(u, `${HEADER}\nA,,,,0,,,,,,`)).status).toBe(403);
    });

    it('never changes staff accounts or unknown emails', async () => {
      const a = await admin(); const m = await signup(); await repos.users.update(m.id, { role: 'MODERATOR' });
      expect((await http().post('/admin/organisations').set(bearer(a.token)).send({ email: m.email, enabled: true })).status).toBe(400);
      expect((await http().post('/admin/organisations').set(bearer(a.token)).send({ email: 'nobody@example.com', enabled: true })).status).toBe(404);
    });

    it('creates the good rows, explains the bad ones line by line, and uses the pickup location as the default', async () => {
      const o = await org();
      const t1 = `Oak desk ${uniq()}`; const t2 = `Bookcase ${uniq()}`;
      const csv = [
        HEADER,
        `"${t1}","Solid oak, 2 drawers",furniture,good,0,,,,,https://cdn.example.com/desk.jpg,7`,
        `${t2},Tall,furniture,LIKE_NEW,0,usd,Warehouse door 3,,,,`,
        `Broken,,furniture,MINT,0,,,,,,`,
        `Bad price,,furniture,GOOD,12.345.6,,,,,,`,
        `No coords half,,furniture,GOOD,0,,,53.8,,,`,
        `${t1.replace('Oak desk', 'Oak desk')},Solid oak, 2 drawers,furniture,GOOD,0,,,,,,`,
        `Wrong category,,spaceships,GOOD,0,,,,,,`,
      ].join('\n');
      const r = (await upload(o, csv).expect(201)).body;
      expect(r).toMatchObject({ total: 7, created: 2, failed: 5, ignoredColumns: [] });
      expect(r.results.filter((x: any) => x.ok).map((x: any) => x.line)).toEqual([2, 3]);
      const byLine = Object.fromEntries(r.results.map((x: any) => [x.line, x]));
      expect(byLine[4].error).toMatch(/condition/i);
      expect(byLine[5].error).toMatch(/amount/i);
      expect(byLine[6].error).toMatch(/both lat and lng/i);
      expect(byLine[8].error).toMatch(/category/i);
      const stored = (await repos.listings.findById(byLine[2].id))!;
      expect(stored).toMatchObject({ title: t1, sellerUserId: o.id, isFree: true, currency: 'USD', locationLabel: 'Leeds city centre', categoryKey: 'furniture', condition: 'GOOD' });
      expect(stored.lat).toBeCloseTo(53.8008, 3); // the saved pickup location was the default
      expect((await repos.listings.findById(byLine[3].id))!.locationLabel).toBe('Warehouse door 3');
      expect((await repos.audit.list(0, 20)).items.some((a) => a.action === 'ORG_IMPORT')).toBe(true);
    });

    it('treats a re-upload of the same file as duplicates instead of creating copies', async () => {
      const o = await org();
      const csv = `${HEADER}\nSteel shelf ${uniq()},Four tiers,household,GOOD,0,,,,,,`;
      expect((await upload(o, csv).expect(201)).body.created).toBe(1);
      const again = (await upload(o, csv).expect(201)).body;
      expect(again).toMatchObject({ created: 0, failed: 1 });
      expect(again.results[0].error).toMatch(/duplicate/i);
    });

    it('asks for a location when there is none, and reports unknown columns', async () => {
      const o = await org(false);
      const r = (await upload(o, `title,price,colour\nChair ${uniq()},0,red`).expect(201)).body;
      expect(r).toMatchObject({ created: 0, failed: 1, ignoredColumns: ['colour'] });
      expect(r.results[0].error).toMatch(/location/i);
    });

    it('rejects files it cannot trust', async () => {
      const o = await org();
      expect((await upload(o, '')).status).toBe(400);
      expect((await upload(o, 'name,price\nA,0')).status).toBe(400); // no title column
      expect((await upload(o, `${HEADER}`)).status).toBe(400); // header only
      expect((await upload(o, `${HEADER}\n"unterminated,,,,0`)).status).toBe(400);
      const many = [HEADER, ...Array.from({ length: 101 }, (_, i) => `Item ${i} ${uniq()},,,,0,,,,,,`)].join('\n');
      const r = await upload(o, many);
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/at most 100/);
      expect((await http().post('/org/listings/import').set(bearer(o.token)).send({ csv: 'x', extra: 1 })).status).toBe(400);
    });

    it('lets approved organisations skip the email-verification gate, like other trusted accounts', async () => {
      const o = await org();
      const r = (await upload(o, `${HEADER}\nBench ${uniq()},,furniture,GOOD,0,,,,,,`).expect(201)).body;
      expect(r.created).toBe(1);
    });
  });
});
