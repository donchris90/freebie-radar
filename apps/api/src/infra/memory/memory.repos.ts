import { randomUUID } from 'crypto';
import { haversineKm } from '../../core/geo';
import { isPubliclyListed } from '../../core/lifecycle';
import { normalizeText } from '../../core/dedup';
import type { Comparable } from '../../core/scoring';
import type {
  AlertRec,
  AppealRec,
  AuditRec,
  BillingEventRec,
  ConversationRec,
  CountryRec,
  DeliveryRec,
  ListingRec,
  MessageRec,
  MessageReportRec,
  BlockRec,
  ClaimRec,
  CodeRec,
  ModerationRec,
  PaymentRec,
  ReferralCodeRec,
  RefreshRec,
  ReportRec,
  ResaleRec,
  SourceRec,
  SubscriptionRec,
  SyncRunRec,
  UserRec,
} from '../../domain/models';
import type { ClaimTally, ListingSearchFilter, Repos } from '../../domain/ports';

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory persistence for tests and local development. Refuses to run in production. */
export function createMemoryRepos(): Repos {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The in-memory repositories must not be used in production. Configure the Prisma adapter.');
  }

  const users = new Map<string, UserRec>();
  const listings = new Map<string, ListingRec>();
  const saved = new Map<string, Set<string>>();
  const dismissed = new Map<string, Set<string>>();
  const weights = new Map<string, Record<string, number>>();
  const reports = new Map<string, ReportRec>();
  const alerts = new Map<string, AlertRec>();
  const deliveries = new Map<string, DeliveryRec>();
  const resale = new Map<string, ResaleRec>();
  const audit: AuditRec[] = [];
  const subscriptions = new Map<string, SubscriptionRec>();
  const payments = new Map<string, PaymentRec>();
  const billingEvents = new Map<string, BillingEventRec>();
  const conversations = new Map<string, ConversationRec>();
  const claims = new Map<string, ClaimRec>();
  const referralCodes = new Map<string, ReferralCodeRec>();
  const messages: MessageRec[] = [];
  const messageReports = new Map<string, MessageReportRec>();
  const sources = new Map<string, SourceRec>();
  const syncRuns: SyncRunRec[] = [];
  const moderation = new Map<string, ModerationRec>();
  const appeals = new Map<string, AppealRec>();
  const countries = new Map<string, CountryRec>();
  const refresh = new Map<string, RefreshRec>();
  const codes = new Map<string, CodeRec>();
  const blocks = new Map<string, BlockRec>();

  const matchesFilter = (l: ListingRec, f: ListingSearchFilter): boolean => {
    if (f.publicOnly && (!isPubliclyListed(l.status) || l.duplicateOfId !== null)) return false;
    if (f.sellerUserId && l.sellerUserId !== f.sellerUserId) return false;
    if (f.excludeSellerIds?.length && l.sellerUserId && f.excludeSellerIds.includes(l.sellerUserId)) return false;
    if (f.categoryKey && l.categoryKey !== f.categoryKey) return false;
    if (f.countryCode && l.countryCode !== f.countryCode) return false;
    if (f.condition && l.condition !== f.condition) return false;
    if (f.freeOnly && !(l.isFree && l.priceMinor === 0)) return false;
    if (f.minPriceMinor !== undefined || f.maxPriceMinor !== undefined) {
      if (l.priceMinor === null || !f.currency || l.currency !== f.currency.toUpperCase()) return false;
      if (f.minPriceMinor !== undefined && l.priceMinor < f.minPriceMinor) return false;
      if (f.maxPriceMinor !== undefined && l.priceMinor > f.maxPriceMinor) return false;
    }
    if (f.q) {
      const hay = ` ${normalizeText(`${l.title} ${l.description}`)} `;
      if (!normalizeText(f.q).split(' ').every((t) => hay.includes(t))) return false;
    }
    if (f.center && f.radiusKm !== undefined) {
      if (haversineKm(f.center.lat, f.center.lng, l.lat, l.lng) > f.radiusKm) return false;
    }
    return true;
  };

  return {
    countries: {
      async list() { return [...countries.values()].sort((a, b) => a.name.localeCompare(b.name)).map(clone); },
      async get(code) { const c = countries.get(code.toUpperCase()); return c ? clone(c) : null; },
      async insertIfMissing(c) { if (!countries.has(c.code)) countries.set(c.code, clone(c)); },
      async setEnabled(code, enabled) {
        const c = countries.get(code.toUpperCase());
        if (!c) return null;
        c.enabled = enabled;
        return clone(c);
      },
    },

    tokens: {
      async addRefresh(r) { refresh.set(r.id, clone(r)); },
      async findRefresh(hash) { for (const r of refresh.values()) if (r.tokenHash === hash) return clone(r); return null; },
      async revokeRefresh(id, at) {
        const r = refresh.get(id);
        if (!r || r.revokedAt) return false;
        r.revokedAt = at;
        return true;
      },
      async revokeFamily(familyId, at) { for (const r of refresh.values()) if (r.familyId === familyId && !r.revokedAt) r.revokedAt = at; },
      async revokeAllForUser(userId, at) { for (const r of refresh.values()) if (r.userId === userId && !r.revokedAt) r.revokedAt = at; },
      async addCode(c) {
        for (const o of codes.values()) if (o.userId === c.userId && o.purpose === c.purpose && !o.usedAt) o.usedAt = c.createdAt;
        codes.set(c.id, clone(c));
      },
      async latestCode(userId, purpose) {
        const mine = [...codes.values()].filter((c) => c.userId === userId && c.purpose === purpose).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return mine[0] ? clone(mine[0]) : null;
      },
      async purgeExpired(now) {
        let n = 0;
        for (const [id, r] of refresh) if (r.expiresAt < now) { refresh.delete(id); n++; }
        for (const [id, c] of codes) if (c.expiresAt.getTime() < now.getTime() - 86_400_000) { codes.delete(id); n++; }
        return n;
      },
      async bumpCodeAttempts(id) { const c = codes.get(id)!; c.attempts += 1; return c.attempts; },
      async consumeCode(id, at) {
        const c = codes.get(id);
        if (!c || c.usedAt) return false;
        c.usedAt = at;
        return true;
      },
    },

    blocks: {
      async add(blockerId, blockedId) { const k = `${blockerId}:${blockedId}`; if (!blocks.has(k)) blocks.set(k, { blockerId, blockedId, createdAt: new Date() }); },
      async remove(blockerId, blockedId) { return blocks.delete(`${blockerId}:${blockedId}`); },
      async list(blockerId) { return [...blocks.values()].filter((b) => b.blockerId === blockerId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(clone); },
      async blockedIds(blockerId) { return [...blocks.values()].filter((b) => b.blockerId === blockerId).map((b) => b.blockedId); },
    },

    users: {
      async insert(u) { users.set(u.id, clone(u)); return clone(u); },
      async findById(id) { const u = users.get(id); return u ? clone(u) : null; },
      async findByEmail(email) {
        const e = email.toLowerCase();
        for (const u of users.values()) if (u.email === e) return clone(u);
        return null;
      },
      async update(id, patch) {
        const u = users.get(id);
        if (!u) return null;
        const next = { ...u, ...clone(patch) };
        users.set(id, next);
        return clone(next);
      },
      async idsReferredBy(code, limit) {
        return [...users.values()].filter((u) => u.referredByCode === code).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map((u) => ({ id: u.id, emailVerifiedAt: u.emailVerifiedAt }));
      },
    },

    listings: {
      async insert(l) {
        for (const e of listings.values()) {
          if (e.externalId && e.externalId === l.externalId && e.sourceKey === l.sourceKey) {
            throw new Error('Duplicate (sourceKey, externalId)');
          }
        }
        listings.set(l.id, clone(l));
        return clone(l);
      },
      async findById(id) { const l = listings.get(id); return l ? clone(l) : null; },
      async update(id, patch) {
        const l = listings.get(id);
        if (!l) return null;
        const next = { ...l, ...clone(patch) };
        listings.set(id, next);
        return clone(next);
      },
      async search(f) {
        let rows = [...listings.values()].filter((l) => matchesFilter(l, f));
        if (f.sort === 'nearest' && f.center) {
          const c = f.center;
          rows.sort((a, b) => haversineKm(c.lat, c.lng, a.lat, a.lng) - haversineKm(c.lat, c.lng, b.lat, b.lng));
        } else {
          rows.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime() || a.id.localeCompare(b.id));
        }
        const total = rows.length;
        rows = rows.slice(f.offset, f.offset + f.limit);
        return { items: rows.map(clone), total };
      },
      async findNear(lat, lng, radiusKm, excludeId) {
        return [...listings.values()]
          .filter((l) => l.id !== excludeId && haversineKm(lat, lng, l.lat, l.lng) <= radiusKm)
          .map(clone);
      },
      async countBySellerSince(sellerId, since) {
        return [...listings.values()].filter((l) => l.sellerUserId === sellerId && l.postedAt >= since).length;
      },
      async countBySellerSourceSince(sellerId, sourceKey, since) {
        return [...listings.values()].filter((l) => l.sellerUserId === sellerId && l.sourceKey === sourceKey && l.postedAt >= since).length;
      },
      async countBySellerIds(ids) {
        const set = new Set(ids);
        return [...listings.values()].filter((l) => l.sellerUserId && set.has(l.sellerUserId) && l.status !== 'REMOVED' && l.status !== 'UNDER_REVIEW').length;
      },
      async countSameContentBySeller(sellerId, hash, since) {
        return [...listings.values()].filter((l) => l.sellerUserId === sellerId && l.contentHash === hash && l.postedAt >= since).length;
      },
      async comparablesFor(l): Promise<Comparable[]> {
        return [...listings.values()]
          .filter(
            (c) =>
              c.id !== l.id &&
              c.duplicateOfId === null && // a duplicate must not count twice as evidence
              c.status === 'ACTIVE' &&
              c.priceMinor !== null &&
              c.priceMinor > 0 &&
              c.currency === l.currency &&
              c.countryCode === l.countryCode &&
              c.categoryKey === l.categoryKey,
          )
          .map((c) => ({
            id: c.id,
            priceMinor: c.priceMinor as number,
            currency: c.currency,
            countryCode: c.countryCode,
            categoryKey: c.categoryKey,
            observedAt: c.postedAt,
          }));
      },
      async findBySourceExternal(sourceKey, externalId) {
        const l = [...listings.values()].find((x) => x.sourceKey === sourceKey && x.externalId === externalId);
        return l ? clone(l) : null;
      },
      async listForExpiry() {
        return [...listings.values()].filter((l) => l.status === 'ACTIVE' || l.status === 'POSSIBLY_EXPIRED' || l.status === 'REPORTED_UNAVAILABLE').map(clone);
      },
    },

    sources: {
      async list() { return [...sources.values()].sort((a, b) => a.key.localeCompare(b.key)).map(clone); },
      async get(key) { const r = sources.get(key); return r ? clone(r) : null; },
      async upsertConfig(rec) {
        const cur = sources.get(rec.key);
        const next = { ...clone(rec), enabled: cur ? cur.enabled : rec.enabled };
        sources.set(rec.key, next);
        return clone(next);
      },
      async setEnabled(key, enabled) {
        const r = sources.get(key);
        if (!r) return null;
        r.enabled = enabled;
        return clone(r);
      },
    },

    syncRuns: {
      async start(r) { syncRuns.push(clone(r)); },
      async finish(id, patch, at) {
        const r = syncRuns.find((x) => x.id === id);
        if (r) Object.assign(r, patch, { finishedAt: at });
      },
      async recent(sourceKey, limit) {
        return syncRuns.filter((r) => !sourceKey || r.sourceKey === sourceKey).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, limit).map(clone);
      },
      async lastOkStartedAt(sourceKey) {
        const ok = syncRuns.filter((r) => r.sourceKey === sourceKey && r.status === 'OK').sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        return ok[0] ? ok[0].startedAt : null;
      },
    },

    saved: {
      async save(u, l) { (saved.get(u) ?? saved.set(u, new Set()).get(u)!).add(l); },
      async unsave(u, l) { saved.get(u)?.delete(l); },
      async listIds(u) { return [...(saved.get(u) ?? [])]; },
      async dismiss(u, l) { (dismissed.get(u) ?? dismissed.set(u, new Set()).get(u)!).add(l); },
      async dismissedIds(u) { return [...(dismissed.get(u) ?? [])]; },
      async bumpCategory(u, c) {
        const w = weights.get(u) ?? {};
        w[c] = (w[c] ?? 0) + 1;
        weights.set(u, w);
      },
      async categoryWeights(u) { return { ...(weights.get(u) ?? {}) }; },
      async resetPersonalisation(u) { weights.delete(u); dismissed.delete(u); },
    },

    reports: {
      async create(r) {
        for (const e of reports.values()) {
          if (e.listingId === r.listingId && e.reporterId === r.reporterId && e.reason === r.reason) return null;
        }
        reports.set(r.id, clone(r));
        return clone(r);
      },
      async findById(id) { const r = reports.get(id); return r ? clone(r) : null; },
      async distinctOpenReporters(listingId, reasons) {
        const s = new Set<string>();
        for (const r of reports.values()) {
          if (r.listingId === listingId && r.status === 'OPEN' && (!reasons || reasons.includes(r.reason))) s.add(r.reporterId);
        }
        return s.size;
      },
      async listByStatus(status, offset, limit) {
        const rows = [...reports.values()].filter((r) => r.status === status).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return { items: rows.slice(offset, offset + limit).map(clone), total: rows.length };
      },
      async setStatus(id, status) { const r = reports.get(id); if (r) r.status = status; },
      async setStatusForListing(listingId, status) {
        for (const r of reports.values()) if (r.listingId === listingId && r.status === 'OPEN') r.status = status;
      },
    },

    claims: {
      async insertActive(c) {
        if ([...claims.values()].some((x) => x.listingId === c.listingId && (x.status === 'HELD' || x.status === 'CONFIRMED'))) return null;
        claims.set(c.id, clone(c));
        return clone(c);
      },
      async findById(id) { const c = claims.get(id); return c ? clone(c) : null; },
      async activeForListing(listingId) {
        const c = [...claims.values()].find((x) => x.listingId === listingId && (x.status === 'HELD' || x.status === 'CONFIRMED'));
        return c ? clone(c) : null;
      },
      async activeListingIds(ids) {
        const set = new Set(ids);
        return [...new Set([...claims.values()].filter((x) => set.has(x.listingId) && (x.status === 'HELD' || x.status === 'CONFIRMED')).map((x) => x.listingId))];
      },
      async countActiveByClaimer(claimerId) {
        return [...claims.values()].filter((x) => x.claimerId === claimerId && (x.status === 'HELD' || x.status === 'CONFIRMED')).length;
      },
      async transition(id, from, patch) {
        const c = claims.get(id);
        if (!c || !from.includes(c.status)) return null;
        Object.assign(c, clone(patch));
        return clone(c);
      },
      async listForClaimer(userId, limit) { return [...claims.values()].filter((c) => c.claimerId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map(clone); },
      async listForGiver(userId, limit) { return [...claims.values()].filter((c) => c.giverId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map(clone); },
      async listActive(limit) {
        return [...claims.values()].filter((c) => c.status === 'HELD' || c.status === 'CONFIRMED').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit).map(clone);
      },
      async tally(userId): Promise<ClaimTally> {
        const all = [...claims.values()];
        return {
          collected: all.filter((c) => c.claimerId === userId && c.status === 'COLLECTED').length,
          noShow: all.filter((c) => c.claimerId === userId && c.status === 'NO_SHOW').length,
          lateCancel: all.filter((c) => c.claimerId === userId && c.status === 'CANCELLED' && c.endedBy === 'CLAIMER' && c.confirmedAt !== null).length,
          given: all.filter((c) => c.giverId === userId && c.status === 'COLLECTED').length,
        };
      },
      async countCollectedForGivers(ids) {
        const set = new Set(ids);
        return [...claims.values()].filter((c) => set.has(c.giverId) && c.status === 'COLLECTED').length;
      },
    },

    referrals: {
      async insert(r) {
        if (referralCodes.has(r.code)) return null;
        referralCodes.set(r.code, clone(r));
        return clone(r);
      },
      async find(code) { const r = referralCodes.get(code); return r ? clone(r) : null; },
      async findByOwner(userId) { const r = [...referralCodes.values()].find((x) => x.ownerUserId === userId); return r ? clone(r) : null; },
      async list() { return [...referralCodes.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone); },
      async setActive(code, active) { const r = referralCodes.get(code); if (!r) return null; r.active = active; return clone(r); },
    },

    conversations: {
      async insert(c) {
        if ([...conversations.values()].some((x) => x.listingId === c.listingId && x.buyerId === c.buyerId)) return null;
        conversations.set(c.id, clone(c));
        return clone(c);
      },
      async findById(id) { const c = conversations.get(id); return c ? clone(c) : null; },
      async findByListingBuyer(listingId, buyerId) {
        const c = [...conversations.values()].find((x) => x.listingId === listingId && x.buyerId === buyerId);
        return c ? clone(c) : null;
      },
      async listForUser(userId, limit) {
        return [...conversations.values()].filter((c) => c.buyerId === userId || c.sellerId === userId).sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime()).slice(0, limit).map(clone);
      },
      async update(id, patch) { const c = conversations.get(id); if (c) Object.assign(c, clone(patch)); },
      async countStartedBy(buyerId, since) { return [...conversations.values()].filter((c) => c.buyerId === buyerId && c.createdAt >= since).length; },
      async addMessage(m) { messages.push(clone(m)); },
      async findMessage(id) { const m = messages.find((x) => x.id === id); return m ? clone(m) : null; },
      async messages(conversationId, before, limit) {
        const rows = messages.filter((m) => m.conversationId === conversationId && (!before || m.createdAt < before)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
        return rows.slice(Math.max(0, rows.length - limit)).map(clone);
      },
      async countMessagesBy(senderId, since) { return messages.filter((m) => m.senderId === senderId && m.createdAt >= since).length; },
      async countUnansweredBy(conversationId, senderId) {
        const inConv = messages.filter((m) => m.conversationId === conversationId);
        const lastOther = inConv.filter((m) => m.senderId !== senderId).reduce<Date | null>((a, m) => (!a || m.createdAt > a ? m.createdAt : a), null);
        return inConv.filter((m) => m.senderId === senderId && (!lastOther || m.createdAt > lastOther)).length;
      },
      async addReport(r) {
        if ([...messageReports.values()].some((x) => x.messageId === r.messageId && x.reporterId === r.reporterId)) return null;
        messageReports.set(r.id, clone(r));
        return clone(r);
      },
      async findReport(id) { const r = messageReports.get(id); return r ? clone(r) : null; },
      async listReports(status, offset, limit) {
        const rows = [...messageReports.values()].filter((r) => r.status === status).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return { items: rows.slice(offset, offset + limit).map(clone), total: rows.length };
      },
      async setReportStatus(id, status) { const r = messageReports.get(id); if (r) r.status = status; },
    },

    billing: {
      async getSubscription(userId) { const s = subscriptions.get(userId); return s ? clone(s) : null; },
      async findSubscriptionByRef(provider, ref) {
        const s = [...subscriptions.values()].find((x) => x.provider === provider && x.providerRef === ref);
        return s ? clone(s) : null;
      },
      async saveSubscription(s) { subscriptions.set(s.userId, clone(s)); },
      async listSubscriptions(statuses) { return [...subscriptions.values()].filter((s) => statuses.includes(s.status)).map(clone); },
      async insertPayment(p) {
        const all = [...payments.values()];
        if (all.some((x) => x.reference === p.reference || (p.providerPaymentRef && x.providerPaymentRef === p.providerPaymentRef))) return null;
        payments.set(p.id, clone(p));
        return clone(p);
      },
      async findPayment(reference) { const p = [...payments.values()].find((x) => x.reference === reference); return p ? clone(p) : null; },
      async findPaymentByProviderRef(ref) { const p = [...payments.values()].find((x) => x.providerPaymentRef === ref); return p ? clone(p) : null; },
      async transitionPayment(id, from, patch) {
        const p = payments.get(id);
        if (!p || !from.includes(p.status)) return false;
        Object.assign(p, clone(patch));
        return true;
      },
      async listPayments(f) {
        const rows = [...payments.values()].filter((p) => !f.userId || p.userId === f.userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { items: rows.slice(f.offset, f.offset + f.limit).map(clone), total: rows.length };
      },
      async stalePending(before) { return [...payments.values()].filter((p) => p.status === 'PENDING' && p.createdAt < before).map(clone); },
      async beginEvent(provider, eventKey, type) {
        const existing = [...billingEvents.values()].find((e) => e.provider === provider && e.eventKey === eventKey);
        if (existing) return { event: clone(existing), created: false };
        const event: BillingEventRec = { id: randomUUID(), provider, eventKey, type, status: 'RECEIVED', error: null, attempts: 1, receivedAt: new Date(), processedAt: null };
        billingEvents.set(event.id, event);
        return { event: clone(event), created: true };
      },
      async retryEvent(id) { const e = billingEvents.get(id); if (e) { e.attempts++; e.status = 'RECEIVED'; e.error = null; } },
      async finishEvent(id, status, error) { const e = billingEvents.get(id); if (e) { e.status = status; e.error = error; e.processedAt = new Date(); } },
      async listEvents(f) {
        return [...billingEvents.values()].filter((e) => !f.status || e.status === f.status).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()).slice(0, f.limit).map(clone);
      },
    },

    alerts: {
      async create(a) { alerts.set(a.id, clone(a)); return clone(a); },
      async listByUser(u) { return [...alerts.values()].filter((a) => a.userId === u).map(clone); },
      async findById(id) { const a = alerts.get(id); return a ? clone(a) : null; },
      async update(id, patch) {
        const a = alerts.get(id);
        if (!a) return null;
        const next = { ...a, ...clone(patch) };
        alerts.set(id, next);
        return clone(next);
      },
      async delete(id) { alerts.delete(id); },
      async listActive() { return [...alerts.values()].filter((a) => a.active).map(clone); },
      async recordDelivery(d) {
        for (const e of deliveries.values()) if (e.alertId === d.alertId && e.listingId === d.listingId) return null;
        deliveries.set(d.id, clone(d));
        return clone(d);
      },
      async setDeliveryStatus(id, status, reason) {
        const d = deliveries.get(id);
        if (d) { d.status = status; d.reason = reason ?? null; }
      },
      async countSentSince(userId, since) {
        let n = 0;
        for (const d of deliveries.values()) {
          const a = alerts.get(d.alertId);
          if (a?.userId === userId && d.status === 'SENT' && d.createdAt >= since) n++;
        }
        return n;
      },
      async listDeliveries(userId, limit) {
        return [...deliveries.values()]
          .filter((d) => alerts.get(d.alertId)?.userId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map(clone);
      },
      async listPendingDeliveries() {
        return [...deliveries.values()].filter((d) => d.status === 'PENDING').map(clone);
      },
    },

    resale: {
      async create(r) { resale.set(r.id, clone(r)); return clone(r); },
      async listByUser(u) { return [...resale.values()].filter((r) => r.userId === u).map(clone); },
      async findById(id) { const r = resale.get(id); return r ? clone(r) : null; },
      async delete(id) { resale.delete(id); },
    },

    audit: {
      async add(a) { audit.push(clone(a)); },
      async list(offset, limit) {
        const rows = [...audit].reverse();
        return { items: rows.slice(offset, offset + limit).map(clone), total: rows.length };
      },
    },

    moderation: {
      async add(m) { moderation.set(m.id, clone(m)); return clone(m); },
      async findById(id) { const m = moderation.get(id); return m ? clone(m) : null; },
      async addAppeal(a) { appeals.set(a.id, clone(a)); return clone(a); },
      async listAppeals(status) { return [...appeals.values()].filter((a) => a.status === status).map(clone); },
      async findAppeal(id) { const a = appeals.get(id); return a ? clone(a) : null; },
      async setAppealStatus(id, status) { const a = appeals.get(id); if (a) a.status = status; },
      async latestForListing(listingId) {
        const rows = [...moderation.values()].filter((m) => m.listingId === listingId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ? clone(rows[0]) : null;
      },
    },

    stats: {
      async stats() {
        const count = (key: (l: ListingRec) => string) => {
          const o: Record<string, number> = {};
          for (const l of listings.values()) o[key(l)] = (o[key(l)] ?? 0) + 1;
          return o;
        };
        const byDelivery: Record<string, number> = {};
        for (const d of deliveries.values()) byDelivery[d.status] = (byDelivery[d.status] ?? 0) + 1;
        return {
          users: users.size,
          listingsByStatus: count((l) => l.status),
          listingsBySource: count((l) => l.sourceKey),
          listingsByCountry: count((l) => l.countryCode),
          duplicateListings: [...listings.values()].filter((l) => l.duplicateOfId).length,
          openReports: [...reports.values()].filter((r) => r.status === 'OPEN').length,
          deliveriesByStatus: byDelivery,
        };
      },
    },
  };
}
