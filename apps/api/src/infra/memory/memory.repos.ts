import { haversineKm } from '../../core/geo';
import { isPubliclyListed } from '../../core/lifecycle';
import { normalizeText } from '../../core/dedup';
import type { Comparable } from '../../core/scoring';
import type {
  AlertRec,
  AppealRec,
  AuditRec,
  CountryRec,
  DeliveryRec,
  ListingRec,
  ModerationRec,
  ReportRec,
  ResaleRec,
  UserRec,
} from '../../domain/models';
import type { ListingSearchFilter, Repos } from '../../domain/ports';

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
  const moderation = new Map<string, ModerationRec>();
  const appeals = new Map<string, AppealRec>();
  const countries = new Map<string, CountryRec>();

  const matchesFilter = (l: ListingRec, f: ListingSearchFilter): boolean => {
    if (f.publicOnly && (!isPubliclyListed(l.status) || l.duplicateOfId !== null)) return false;
    if (f.sellerUserId && l.sellerUserId !== f.sellerUserId) return false;
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
      async listForExpiry() {
        return [...listings.values()].filter((l) => l.status === 'ACTIVE' || l.status === 'POSSIBLY_EXPIRED' || l.status === 'REPORTED_UNAVAILABLE').map(clone);
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
