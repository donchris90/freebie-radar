import './env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PUSH_SENDER, PushMessage, REPOS, Repos } from '../src/domain/ports';
import { configureApp } from '../src/main';

let n = 0;
const uniq = () => `${Date.now()}${++n}`;

describe('in-app messaging', () => {
  let app: INestApplication;
  let repos: Repos;
  const pushed: PushMessage[] = [];
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const push = { isConfigured: () => true, send: async (m: PushMessage) => { pushed.push(m); return { sent: true }; } };
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PUSH_SENDER).useValue(push).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    repos = app.get<Repos>(REPOS);
  });
  afterAll(() => app?.close());

  async function signup(name = 'Person') {
    const r = await http().post('/auth/register').send({ email: `m${uniq()}@example.com`, password: 'correct-horse-battery', displayName: name }).expect(201);
    return { token: r.body.accessToken as string, id: r.body.user.id as string, email: r.body.user.email as string };
  }
  async function post(seller: { token: string }, title = `Desk ${uniq()}`) {
    const r = await http().post('/listings').set(bearer(seller.token)).send({ title, description: 'Solid oak', categoryKey: 'furniture', condition: 'GOOD', price: '30', currency: 'USD', lat: 40.7 + Math.random() / 50, lng: -74 + Math.random() / 50, locationLabel: 'NYC' }).expect(201);
    return r.body.id as string;
  }
  const start = (t: { token: string }, listingId: string, message: string) => http().post(`/listings/${listingId}/conversations`).set(bearer(t.token)).send({ message });

  it('needs sign-in', async () => {
    expect((await http().get('/conversations')).status).toBe(401);
  });

  it('lets a buyer message a seller without either seeing the other\'s contact details', async () => {
    const seller = await signup('Sam Seller');
    const buyer = await signup('Bea Buyer');
    const id = await post(seller);
    const s = await start(buyer, id, 'Hi, is this still available? I can collect tomorrow.').expect(201);
    expect(s.body.message).toMatchObject({ mine: true, body: expect.stringContaining('still available') });

    const inbox = (await http().get('/conversations').set(bearer(seller.token)).expect(200)).body;
    expect(inbox.unread).toBe(1);
    expect(inbox.items[0]).toMatchObject({ role: 'SELLER', unread: true, canReply: true, other: { displayName: 'Bea Buyer' }, lastMessage: { mine: false } });
    const everything = JSON.stringify([inbox, (await http().get('/conversations').set(bearer(buyer.token))).body, s.body]);
    expect(everything).not.toContain(buyer.email);
    expect(everything).not.toContain(seller.email);

    const thread = (await http().get(`/conversations/${s.body.conversationId}`).set(bearer(seller.token)).expect(200)).body;
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].mine).toBe(false);
    expect((await http().get('/conversations').set(bearer(seller.token))).body.unread).toBe(0); // opening marks it read

    await http().post(`/conversations/${s.body.conversationId}/messages`).set(bearer(seller.token)).send({ message: 'Yes, 5pm works.' }).expect(201);
    const back = (await http().get(`/conversations/${s.body.conversationId}`).set(bearer(buyer.token))).body;
    expect(back.messages.map((m: any) => m.body)).toEqual(['Hi, is this still available? I can collect tomorrow.', 'Yes, 5pm works.']);
  });

  it('reuses one conversation per buyer and listing', async () => {
    const seller = await signup(); const buyer = await signup();
    const id = await post(seller);
    const a = await start(buyer, id, 'First message').expect(201);
    const b = await start(buyer, id, 'Second message').expect(201);
    expect(b.body.conversationId).toBe(a.body.conversationId);
    expect((await http().get('/conversations').set(bearer(buyer.token))).body.items).toHaveLength(1);
  });

  it('only notifies the other person, and never puts the message text in the push', async () => {
    const seller = await signup(); const buyer = await signup();
    await repos.users.update(seller.id, { prefs: { ...(await repos.users.findById(seller.id))!.prefs, pushEnabled: true, pushToken: 'ExpoPushToken[seller]' } });
    pushed.length = 0;
    await start(buyer, await post(seller), 'Secret offer: would you take 20?').expect(201);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].token).toBe('ExpoPushToken[seller]');
    expect(JSON.stringify(pushed[0])).not.toContain('Secret offer');
  });

  it('refuses phone numbers, emails and links with an explanation', async () => {
    const seller = await signup(); const buyer = await signup();
    const id = await post(seller);
    for (const body of ['call me on 07700 900123', 'mail bob@example.com', 'see https://example.org/x']) {
      const r = await start(buyer, id, body);
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/do not share|not allowed/i);
    }
    expect((await http().get('/conversations').set(bearer(buyer.token))).body.items).toHaveLength(0); // nothing was created
  });

  it('delivers a pay-in-advance message but warns only the recipient', async () => {
    const seller = await signup(); const buyer = await signup();
    const s = await start(buyer, await post(seller), 'Please send a deposit and I will hold it').expect(201);
    expect(s.body.message.caution).toBeUndefined();
    const seen = (await http().get(`/conversations/${s.body.conversationId}`).set(bearer(seller.token))).body.messages[0];
    expect(seen.caution).toMatch(/Never pay before/);
  });

  it('keeps strangers out of a conversation', async () => {
    const seller = await signup(); const buyer = await signup(); const stranger = await signup();
    const s = await start(buyer, await post(seller), 'Hello there').expect(201);
    const cid = s.body.conversationId;
    expect((await http().get(`/conversations/${cid}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await http().post(`/conversations/${cid}/messages`).set(bearer(stranger.token)).send({ message: 'hi' })).status).toBe(404);
    expect((await http().post(`/conversations/${cid}/block`).set(bearer(stranger.token))).status).toBe(404);
  });

  it('rejects own listings, outside-source listings, empty and oversized messages', async () => {
    const seller = await signup(); const buyer = await signup();
    const id = await post(seller);
    expect((await start(seller, id, 'talking to myself')).status).toBe(400);
    expect((await start(buyer, id, '   ')).status).toBe(400);
    expect((await start(buyer, id, 'x'.repeat(1001))).status).toBe(400);
    expect((await start(buyer, '00000000-0000-0000-0000-000000000000', 'hi')).status).toBe(404);
    const ext = await http().post('/listings').set(bearer(seller.token)).send({ title: 'External thing', description: 'on another site', categoryKey: 'other', condition: 'GOOD', price: '5', currency: 'USD', lat: 40.7, lng: -74, contactMethod: 'EXTERNAL_LINK', externalUrl: 'https://example.com/thing' }).expect(201);
    // a user-shared link still belongs to a user, so messaging works; only source listings (no seller) refuse
    expect((await start(buyer, ext.body.id, 'hello')).status).toBe(201);
    const src = await repos.listings.insert({ ...(await repos.listings.findById(id))!, id: '11111111-1111-4111-8111-111111111111', sourceKey: 'partner-x', externalId: 'x1', sellerUserId: null, canonicalUrl: null, contactMethod: 'EXTERNAL_LINK', externalUrl: 'https://p.example/1' });
    const r = await start(buyer, src.id, 'hello');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/outside source/);
  });

  describe('abuse controls', () => {
    it('limits new conversations per day', async () => {
      const buyer = await signup();
      const results: number[] = [];
      for (let i = 0; i < 11; i++) {
        const seller = await signup();
        results.push((await start(buyer, await post(seller), 'Is this available?')).status);
      }
      expect(results.slice(0, 10).every((s) => s === 201)).toBe(true);
      expect(results[10]).toBe(429);
    });

    it('limits unanswered messages, then lets the conversation continue once the seller replies', async () => {
      const seller = await signup(); const buyer = await signup();
      const s = await start(buyer, await post(seller), 'message 1').expect(201);
      const cid = s.body.conversationId;
      for (let i = 2; i <= 5; i++) await http().post(`/conversations/${cid}/messages`).set(bearer(buyer.token)).send({ message: `message ${i}` }).expect(201);
      const blocked = await http().post(`/conversations/${cid}/messages`).set(bearer(buyer.token)).send({ message: 'message 6' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.message).toMatch(/without a reply/);
      await http().post(`/conversations/${cid}/messages`).set(bearer(seller.token)).send({ message: 'Yes, still here' }).expect(201);
      await http().post(`/conversations/${cid}/messages`).set(bearer(buyer.token)).send({ message: 'Great, thanks' }).expect(201);
    });
  });

  describe('blocking and reporting', () => {
    it('blocking from a chat hides it, stops contact both ways and does not tell the other person', async () => {
      const seller = await signup(); const buyer = await signup();
      const id = await post(seller);
      const s = await start(buyer, id, 'Hello?').expect(201);
      const cid = s.body.conversationId;
      await http().post(`/conversations/${cid}/block`).set(bearer(seller.token)).expect(201);
      expect((await http().get('/conversations').set(bearer(seller.token))).body.items).toHaveLength(0);
      expect((await http().get(`/conversations/${cid}`).set(bearer(seller.token))).status).toBe(404);
      const r = await http().post(`/conversations/${cid}/messages`).set(bearer(buyer.token)).send({ message: 'Please answer' });
      expect(r.status).toBe(403);
      expect(r.body.message).toBe('This conversation is closed.'); // same wording as any other closure
      const again = await start(buyer, id, 'new try');
      expect(again.status).toBe(404);
    });

    it('reporting a message blocks its sender for the reporter and queues it for a moderator, who sees only that exchange', async () => {
      const seller = await signup(); const buyer = await signup(); const admin = await signup('Mod');
      await repos.users.update(admin.id, { role: 'ADMIN' });
      const s = await start(buyer, await post(seller), 'Pay in advance with a gift card').expect(201);
      const cid = s.body.conversationId;
      const msgId = (await http().get(`/conversations/${cid}`).set(bearer(seller.token))).body.messages[0].id;
      expect((await http().post(`/messages/${msgId}/report`).set(bearer(buyer.token)).send({ reason: 'SCAM' })).status).toBe(400); // own message
      const rep = await http().post(`/messages/${msgId}/report`).set(bearer(seller.token)).send({ reason: 'SCAM', details: 'asked for gift cards' }).expect(201);
      expect(rep.body).toEqual({ reported: true, duplicate: false });
      expect((await http().post(`/messages/${msgId}/report`).set(bearer(seller.token)).send({ reason: 'SCAM' }).expect(201)).body.duplicate).toBe(true);
      expect((await http().get('/conversations').set(bearer(seller.token))).body.items).toHaveLength(0);

      expect((await http().get('/admin/message-reports').set(bearer(seller.token))).status).toBe(403);
      const q = (await http().get('/admin/message-reports').set(bearer(admin.token)).expect(200)).body;
      const row = q.items.find((x: any) => x.message.id === msgId);
      expect(row).toMatchObject({ report: { reason: 'SCAM', details: 'asked for gift cards' }, message: { body: 'Pay in advance with a gift card', flagged: true } });
      expect(JSON.stringify(row)).not.toMatch(/@example\.com/);
      const done = await http().post(`/admin/message-reports/${row.report.id}/resolve`).set(bearer(admin.token)).send({ action: 'ACTION', note: 'Warned the sender' }).expect(201);
      expect(done.body.status).toBe('ACTIONED');
      expect((await http().post(`/admin/message-reports/${row.report.id}/resolve`).set(bearer(admin.token)).send({ action: 'DISMISS', note: 'again' })).status).toBe(400);
    });
  });

  describe('listing availability', () => {
    it('closes the conversation when the listing is gone but keeps the history readable', async () => {
      const seller = await signup(); const buyer = await signup();
      const id = await post(seller);
      const s = await start(buyer, id, 'Can I collect today?').expect(201);
      const cid = s.body.conversationId;
      await http().post(`/listings/${id}/unavailable`).set(bearer(seller.token)).expect(201);
      const view = (await http().get(`/conversations/${cid}`).set(bearer(buyer.token)).expect(200)).body;
      expect(view.conversation).toMatchObject({ canReply: false, closedReason: 'LISTING_UNAVAILABLE', closedMessage: expect.stringContaining('no longer available') });
      expect(view.messages).toHaveLength(1);
      const r = await http().post(`/conversations/${cid}/messages`).set(bearer(buyer.token)).send({ message: 'Hello?' });
      expect(r.status).toBe(403);
      expect((await start(await signup(), id, 'new buyer')).status).toBe(404);
    });

    it('does not open new chats on an unconfirmed listing, but the seller can answer an existing one', async () => {
      const seller = await signup(); const buyer = await signup(); const late = await signup();
      const id = await post(seller);
      const s = await start(buyer, id, 'Still there?').expect(201);
      await repos.listings.update(id, { status: 'POSSIBLY_EXPIRED' });
      const r = await start(late, id, 'Hello');
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/not been confirmed recently/);
      const cid = s.body.conversationId;
      expect((await http().post(`/conversations/${cid}/messages`).set(bearer(buyer.token)).send({ message: 'Anyone?' })).status).toBe(403);
      const sellerView = (await http().get(`/conversations/${cid}`).set(bearer(seller.token))).body.conversation;
      expect(sellerView.canReply).toBe(true);
      await http().post(`/conversations/${cid}/messages`).set(bearer(seller.token)).send({ message: 'Yes it is, confirming now' }).expect(201);
    });

    it('closes conversations with a suspended person', async () => {
      const seller = await signup(); const buyer = await signup(); const admin = await signup();
      await repos.users.update(admin.id, { role: 'ADMIN' });
      const s = await start(buyer, await post(seller), 'Hi').expect(201);
      await http().post(`/admin/users/${seller.id}/status`).set(bearer(admin.token)).send({ status: 'SUSPENDED', reason: 'testing' }).expect(201);
      const r = await http().post(`/conversations/${s.body.conversationId}/messages`).set(bearer(buyer.token)).send({ message: 'Hello?' });
      expect(r.status).toBe(403);
    });
  });
});
