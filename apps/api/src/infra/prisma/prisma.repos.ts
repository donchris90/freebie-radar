/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaClient } from '@prisma/client';
import { normalizeText } from '../../core/dedup';
import { boundingBox, haversineKm, approximateLocation } from '../../core/geo';
import { calculateResale } from '../../core/resale';
import type { RiskSignal } from '../../core/risk';
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
  UserPrefs,
  UserRec,
} from '../../domain/models';
import type { ListingSearchFilter, Repos } from '../../domain/ports';

/**
 * Prisma adapter for the Repos ports. It must behave exactly like infra/memory/memory.repos.ts:
 * the HTTP end-to-end suite is the contract (run it with `npm run test:pg`).
 *
 * Where clauses and create/update payloads are typed loosely on purpose: the shapes are validated by
 * the generated client at runtime and by the Postgres-backed end-to-end suite.
 */

const PUBLIC_STATUSES = ['ACTIVE', 'POSSIBLY_EXPIRED'] as const;
const EXPIRY_STATUSES = ['ACTIVE', 'POSSIBLY_EXPIRED', 'REPORTED_UNAVAILABLE'] as const;
/** Radius searches prefilter in SQL with a bounding box, then refine in memory. This caps the candidate set. */
const GEO_CANDIDATE_CAP = 5000;

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string })?.code === 'P2002';
const isNotFound = (e: unknown): boolean => (e as { code?: string })?.code === 'P2025';

type Row = any;

// ---------------------------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------------------------

const USER_INCLUDE = { preference: true, subscription: true };

function prefsData(p: UserPrefs) {
  return {
    distanceUnit: p.distanceUnit,
    homeLat: p.homeLat,
    homeLng: p.homeLng,
    homeLabel: p.homeLabel,
    locationPrecision: p.locationPrecision,
    personalisationEnabled: p.personalisationEnabled,
    pushEnabled: p.pushEnabled,
    quietHoursStart: p.quietHoursStart,
    quietHoursEnd: p.quietHoursEnd,
    maxPushPerDay: p.maxPushPerDay,
  };
}

function toUser(r: Row): UserRec {
  const p = r.preference;
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.passwordHash,
    displayName: r.displayName,
    role: r.role,
    tier: r.subscription?.tier ?? 'FREE',
    status: r.status,
    countryCode: r.countryCode,
    timeZone: r.timeZone,
    locale: r.locale,
    emailVerifiedAt: r.emailVerifiedAt ?? null,
    tokenVersion: r.tokenVersion ?? 0,
    createdAt: r.createdAt,
    prefs: {
      distanceUnit: p?.distanceUnit === 'km' ? 'km' : 'mi',
      homeLat: p?.homeLat ?? null,
      homeLng: p?.homeLng ?? null,
      homeLabel: p?.homeLabel ?? null,
      locationPrecision: p?.locationPrecision ?? 'approximate',
      personalisationEnabled: p?.personalisationEnabled ?? true,
      pushEnabled: p?.pushEnabled ?? true,
      quietHoursStart: p?.quietHoursStart ?? null,
      quietHoursEnd: p?.quietHoursEnd ?? null,
      maxPushPerDay: p?.maxPushPerDay ?? 10,
      pushToken: r.pushToken ?? null,
    },
  };
}

const LISTING_INCLUDE = { source: true, images: { orderBy: { position: 'asc' } } };

function toListing(r: Row): ListingRec {
  return {
    id: r.id,
    sourceKey: r.source.key,
    externalId: r.externalId ?? null,
    sellerUserId: r.sellerUserId ?? null,
    title: r.title,
    description: r.description,
    categoryKey: r.categoryKey,
    condition: r.condition,
    priceMinor: r.priceMinor ?? null,
    currency: r.currency,
    isFree: r.isFree,
    countryCode: r.countryCode,
    lat: r.lat,
    lng: r.lng,
    locationLabel: r.locationLabel ?? null,
    contactMethod: r.contactMethod,
    externalUrl: r.externalUrl ?? null,
    canonicalUrl: r.canonicalUrl ?? null,
    status: r.status,
    riskLevel: r.riskLevel,
    riskSignals: (Array.isArray(r.riskSignals) ? r.riskSignals : []) as RiskSignal[],
    contentHash: r.contentHash,
    duplicateOfId: r.duplicateOfId ?? null,
    isPromoted: r.isPromoted,
    imageUrls: (r.images ?? []).map((i: Row) => i.url),
    postedAt: r.postedAt,
    lastConfirmedAt: r.lastConfirmedAt,
    expiresAt: r.expiresAt ?? null,
  };
}

const toReport = (r: Row): ReportRec => ({
  id: r.id,
  listingId: r.listingId,
  reporterId: r.reporterId,
  reason: r.reason,
  details: r.details ?? null,
  evidenceUrl: r.evidenceUrl ?? null,
  status: r.status,
  createdAt: r.createdAt,
});

const toAlert = (r: Row): AlertRec => ({
  id: r.id,
  userId: r.userId,
  name: r.name,
  keywords: r.keywords,
  excludedWords: r.excludedWords,
  categories: r.categories,
  minPriceMinor: r.minPriceMinor ?? null,
  maxPriceMinor: r.maxPriceMinor ?? null,
  currency: r.currency ?? null,
  freeOnly: r.freeOnly,
  radiusKm: r.radiusKm ?? null,
  centerLat: r.centerLat ?? null,
  centerLng: r.centerLng ?? null,
  conditions: r.conditions,
  minDealScore: r.minDealScore ?? null,
  sourceKeys: r.sourceKeys,
  frequency: r.frequency,
  active: r.active,
  lastDigestAt: r.lastDigestAt ?? null,
  createdAt: r.createdAt,
});

const toDelivery = (r: Row): DeliveryRec => ({
  id: r.id,
  alertId: r.subscriptionId,
  listingId: r.listingId,
  status: r.status,
  reason: r.reason ?? null,
  createdAt: r.createdAt,
});

const toResale = (r: Row): ResaleRec => ({
  id: r.id,
  userId: r.userId,
  listingId: r.listingId ?? null,
  label: r.label,
  currency: r.currency,
  input: {
    purchaseMinor: r.purchaseMinor,
    resaleMinor: r.resaleMinor,
    transportMinor: r.transportMinor,
    repairMinor: r.repairMinor,
    otherMinor: r.otherMinor,
    feeBasisPoints: r.feeBasisPoints,
    feeFixedMinor: r.feeFixedMinor,
  },
  createdAt: r.createdAt,
});

const toAudit = (r: Row): AuditRec => ({
  id: r.id,
  actorId: r.actorId ?? null,
  action: r.action,
  entityType: r.entityType,
  entityId: r.entityId ?? null,
  metadata: (r.metadata ?? {}) as Record<string, unknown>,
  createdAt: r.createdAt,
});

const toModeration = (r: Row): ModerationRec => ({
  id: r.id,
  listingId: r.listingId ?? '',
  moderatorId: r.moderatorId,
  type: r.type,
  reason: r.reason,
  createdAt: r.createdAt,
});

const toCountry = (r: Row): CountryRec => ({
  code: r.code,
  name: r.name,
  currency: r.currency,
  distanceUnit: r.distanceUnit === 'mi' ? 'mi' : 'km',
  defaultTimeZone: r.defaultTimeZone,
  enabled: r.enabled,
});

const toAppeal = (r: Row): AppealRec => ({
  id: r.id,
  moderationId: r.actionId,
  userId: r.userId,
  message: r.message,
  status: r.status,
  createdAt: r.createdAt,
});

function sourceKind(key: string): 'DIRECT_SUBMISSION' | 'EXTERNAL_LINK' | 'API_PROVIDER' {
  if (key === 'direct') return 'DIRECT_SUBMISSION';
  if (key === 'external-link') return 'EXTERNAL_LINK';
  return 'API_PROVIDER';
}

const countMap = (rows: Row[], key: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r[key])] = r._count._all;
  return out;
};

/** SQL prefilter for a radius query. Handles boxes that cross the antimeridian. */
function geoWhere(lat: number, lng: number, radiusKm: number): any {
  const b = boundingBox(lat, lng, radiusKm);
  const lngCond = b.wrapsAntimeridian
    ? { OR: [{ lng: { gte: b.minLng } }, { lng: { lte: b.maxLng } }] }
    : { lng: { gte: b.minLng, lte: b.maxLng } };
  return { lat: { gte: b.minLat, lte: b.maxLat }, ...lngCond };
}

// ---------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------

export function createPrismaRepos(prisma: PrismaClient): Repos {
  const db = prisma as any;

  /** Sources are created on first use. No cache: tests truncate tables, and one upsert per insert is cheap. */
  async function sourceIdFor(key: string): Promise<string> {
    const row = await db.listingSource.upsert({
      where: { key },
      create: { key, name: key, kind: sourceKind(key) },
      update: {},
    });
    return row.id;
  }

  function listingWhere(f: ListingSearchFilter): any | null {
    const where: any = {};
    const and: any[] = [];
    if (f.publicOnly) {
      where.status = { in: [...PUBLIC_STATUSES] };
      where.duplicateOfId = null;
    }
    if (f.sellerUserId) where.sellerUserId = f.sellerUserId;
    if (f.categoryKey) where.categoryKey = f.categoryKey;
    if (f.countryCode) where.countryCode = f.countryCode;
    if (f.condition) where.condition = f.condition;
    if (f.freeOnly) {
      where.isFree = true;
      where.priceMinor = 0;
    }
    if (f.minPriceMinor !== undefined || f.maxPriceMinor !== undefined) {
      // Price filters only apply together with a currency; unknown prices never match.
      if (!f.currency) return null;
      where.currency = f.currency.toUpperCase();
      const range: any = {};
      if (f.minPriceMinor !== undefined) range.gte = f.minPriceMinor;
      if (f.maxPriceMinor !== undefined) range.lte = f.maxPriceMinor;
      // Combine with the freeOnly equality (priceMinor = 0) without overwriting it.
      and.push({ priceMinor: range });
    }
    if (f.q) {
      for (const token of normalizeText(f.q).split(' ').filter(Boolean)) {
        and.push({
          OR: [
            { title: { contains: token, mode: 'insensitive' } },
            { description: { contains: token, mode: 'insensitive' } },
          ],
        });
      }
    }
    if (f.center && f.radiusKm !== undefined) and.push(geoWhere(f.center.lat, f.center.lng, f.radiusKm));
    // `notIn` alone would also drop listings with no seller (NULL), so keep those explicitly.
    if (f.excludeSellerIds?.length) and.push({ OR: [{ sellerUserId: null }, { sellerUserId: { notIn: f.excludeSellerIds } }] });
    if (and.length) where.AND = and;
    return where;
  }

  return {
    countries: {
      async list() {
        const rows: Row[] = await db.country.findMany({ orderBy: { name: 'asc' } });
        return rows.map(toCountry);
      },
      async get(code) {
        const row = await db.country.findUnique({ where: { code: code.toUpperCase() } });
        return row ? toCountry(row) : null;
      },
      async insertIfMissing(c) {
        await db.country.createMany({ data: [c], skipDuplicates: true });
      },
      async setEnabled(code, enabled) {
        try {
          const row = await db.country.update({ where: { code: code.toUpperCase() }, data: { enabled } });
          return toCountry(row);
        } catch (e) {
          if (isNotFound(e)) return null;
          throw e;
        }
      },
    },

    tokens: {
      async addRefresh(r) {
        await db.refreshToken.create({ data: { id: r.id, userId: r.userId, familyId: r.familyId, tokenHash: r.tokenHash, expiresAt: r.expiresAt, revokedAt: r.revokedAt, createdAt: r.createdAt } });
      },
      async findRefresh(tokenHash) {
        const r = await db.refreshToken.findUnique({ where: { tokenHash } });
        return r ? { id: r.id, userId: r.userId, familyId: r.familyId, tokenHash: r.tokenHash, expiresAt: r.expiresAt, revokedAt: r.revokedAt ?? null, createdAt: r.createdAt } : null;
      },
      async revokeRefresh(id, at) {
        // updateMany with revokedAt: null makes the claim atomic: only one concurrent caller sees count 1.
        const res = await db.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
        return res.count === 1;
      },
      async revokeFamily(familyId, at) {
        await db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: at } });
      },
      async revokeAllForUser(userId, at) {
        await db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } });
      },
      async addCode(c) {
        await db.$transaction([
          db.oneTimeCode.updateMany({ where: { userId: c.userId, purpose: c.purpose, usedAt: null }, data: { usedAt: c.createdAt } }),
          db.oneTimeCode.create({ data: { id: c.id, userId: c.userId, purpose: c.purpose, codeHash: c.codeHash, attempts: 0, expiresAt: c.expiresAt, usedAt: null, createdAt: c.createdAt } }),
        ]);
      },
      async latestCode(userId, purpose) {
        const r = await db.oneTimeCode.findFirst({ where: { userId, purpose }, orderBy: { createdAt: 'desc' } });
        return r ? { id: r.id, userId: r.userId, purpose: r.purpose, codeHash: r.codeHash, attempts: r.attempts, expiresAt: r.expiresAt, usedAt: r.usedAt ?? null, createdAt: r.createdAt } : null;
      },
      async purgeExpired(now) {
        // Revoked-but-unexpired refresh tokens stay: replaying one is how token theft is detected.
        const a = await db.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } });
        const b = await db.oneTimeCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
        return a.count + b.count;
      },
      async bumpCodeAttempts(id) {
        const r = await db.oneTimeCode.update({ where: { id }, data: { attempts: { increment: 1 } } });
        return r.attempts;
      },
      async consumeCode(id, at) {
        const res = await db.oneTimeCode.updateMany({ where: { id, usedAt: null }, data: { usedAt: at } });
        return res.count === 1;
      },
    },

    blocks: {
      async add(blockerId, blockedId) {
        await db.userBlock.upsert({ where: { blockerId_blockedId: { blockerId, blockedId } }, create: { blockerId, blockedId }, update: {} });
      },
      async remove(blockerId, blockedId) {
        const res = await db.userBlock.deleteMany({ where: { blockerId, blockedId } });
        return res.count > 0;
      },
      async list(blockerId) {
        const rows: Row[] = await db.userBlock.findMany({ where: { blockerId }, orderBy: { createdAt: 'desc' } });
        return rows.map((r) => ({ blockerId: r.blockerId, blockedId: r.blockedId, createdAt: r.createdAt }));
      },
      async blockedIds(blockerId) {
        const rows: Row[] = await db.userBlock.findMany({ where: { blockerId }, select: { blockedId: true } });
        return rows.map((r) => r.blockedId);
      },
    },

    users: {
      async insert(u) {
        const row = await db.user.create({
          data: {
            id: u.id,
            email: u.email.toLowerCase(),
            passwordHash: u.passwordHash,
            displayName: u.displayName,
            role: u.role,
            status: u.status,
            countryCode: u.countryCode,
            timeZone: u.timeZone,
            locale: u.locale,
            emailVerifiedAt: u.emailVerifiedAt,
            tokenVersion: u.tokenVersion,
            pushToken: u.prefs.pushToken,
            createdAt: u.createdAt,
            preference: { create: prefsData(u.prefs) },
            ...(u.tier !== 'FREE' ? { subscription: { create: { tier: u.tier, status: 'ACTIVE' } } } : {}),
          },
          include: USER_INCLUDE,
        });
        return toUser(row);
      },
      async findById(id) {
        const row = await db.user.findUnique({ where: { id }, include: USER_INCLUDE });
        return row ? toUser(row) : null;
      },
      async findByEmail(email) {
        const row = await db.user.findUnique({ where: { email: email.toLowerCase() }, include: USER_INCLUDE });
        return row ? toUser(row) : null;
      },
      async update(id, patch) {
        try {
          const data: any = {
            email: patch.email?.toLowerCase(),
            passwordHash: patch.passwordHash,
            displayName: patch.displayName,
            role: patch.role,
            status: patch.status,
            countryCode: patch.countryCode,
            timeZone: patch.timeZone,
            locale: patch.locale,
            emailVerifiedAt: patch.emailVerifiedAt,
            tokenVersion: patch.tokenVersion,
          };
          if (patch.status === 'DELETED') data.deletedAt = new Date();
          if (patch.prefs) {
            data.pushToken = patch.prefs.pushToken;
            data.preference = { upsert: { create: prefsData(patch.prefs), update: prefsData(patch.prefs) } };
          }
          if (patch.tier) {
            data.subscription = {
              upsert: {
                create: { tier: patch.tier, status: patch.tier === 'FREE' ? 'NONE' : 'ACTIVE' },
                update: { tier: patch.tier, status: patch.tier === 'FREE' ? 'NONE' : 'ACTIVE' },
              },
            };
          }
          const row = await db.user.update({ where: { id }, data, include: USER_INCLUDE });
          return toUser(row);
        } catch (e) {
          if (isNotFound(e)) return null;
          throw e;
        }
      },
    },

    listings: {
      async insert(l) {
        const sourceId = await sourceIdFor(l.sourceKey);
        const approx = approximateLocation(l.lat, l.lng);
        try {
          const row = await db.listing.create({
            data: {
              id: l.id,
              sourceId,
              externalId: l.externalId,
              canonicalUrl: l.canonicalUrl,
              sellerUserId: l.sellerUserId,
              title: l.title,
              description: l.description,
              categoryKey: l.categoryKey,
              condition: l.condition,
              priceMinor: l.priceMinor,
              currency: l.currency,
              isFree: l.isFree,
              countryCode: l.countryCode,
              lat: l.lat,
              lng: l.lng,
              approxLat: approx.lat,
              approxLng: approx.lng,
              locationLabel: l.locationLabel,
              contactMethod: l.contactMethod,
              externalUrl: l.externalUrl,
              status: l.status,
              riskLevel: l.riskLevel,
              riskSignals: l.riskSignals as any,
              isPromoted: l.isPromoted,
              contentHash: l.contentHash,
              duplicateOfId: l.duplicateOfId,
              postedAt: l.postedAt,
              lastConfirmedAt: l.lastConfirmedAt,
              expiresAt: l.expiresAt,
              images: { create: l.imageUrls.map((url, position) => ({ url, position })) },
            },
            include: LISTING_INCLUDE,
          });
          return toListing(row);
        } catch (e) {
          if (isUniqueViolation(e)) throw new Error('Duplicate (sourceKey, externalId)');
          throw e;
        }
      },
      async findById(id) {
        const row = await db.listing.findUnique({ where: { id }, include: LISTING_INCLUDE });
        return row ? toListing(row) : null;
      },
      async update(id, patch) {
        const data: any = {
          externalId: patch.externalId,
          canonicalUrl: patch.canonicalUrl,
          sellerUserId: patch.sellerUserId,
          title: patch.title,
          description: patch.description,
          categoryKey: patch.categoryKey,
          condition: patch.condition,
          priceMinor: patch.priceMinor,
          currency: patch.currency,
          isFree: patch.isFree,
          countryCode: patch.countryCode,
          locationLabel: patch.locationLabel,
          contactMethod: patch.contactMethod,
          externalUrl: patch.externalUrl,
          status: patch.status,
          riskLevel: patch.riskLevel,
          isPromoted: patch.isPromoted,
          contentHash: patch.contentHash,
          duplicateOfId: patch.duplicateOfId,
          postedAt: patch.postedAt,
          lastConfirmedAt: patch.lastConfirmedAt,
          expiresAt: patch.expiresAt,
        };
        if (patch.riskSignals !== undefined) data.riskSignals = patch.riskSignals as any;
        if (patch.sourceKey) data.sourceId = await sourceIdFor(patch.sourceKey);
        if (patch.lat !== undefined || patch.lng !== undefined) {
          const current = await db.listing.findUnique({ where: { id }, select: { lat: true, lng: true } });
          if (!current) return null;
          const lat = patch.lat ?? current.lat;
          const lng = patch.lng ?? current.lng;
          const approx = approximateLocation(lat, lng);
          Object.assign(data, { lat, lng, approxLat: approx.lat, approxLng: approx.lng });
        }
        if (patch.imageUrls) {
          data.images = { deleteMany: {}, create: patch.imageUrls.map((url, position) => ({ url, position })) };
        }
        try {
          const row = await db.listing.update({ where: { id }, data, include: LISTING_INCLUDE });
          return toListing(row);
        } catch (e) {
          if (isNotFound(e)) return null;
          throw e;
        }
      },
      async search(f) {
        const where = listingWhere(f);
        if (!where) return { items: [], total: 0 };
        const geo = f.center !== undefined && (f.radiusKm !== undefined || f.sort === 'nearest');
        if (!geo) {
          const [rows, total] = await Promise.all([
            db.listing.findMany({
              where,
              include: LISTING_INCLUDE,
              orderBy: [{ postedAt: 'desc' }, { id: 'asc' }],
              skip: f.offset,
              take: f.limit,
            }),
            db.listing.count({ where }),
          ]);
          return { items: rows.map(toListing), total };
        }
        // Radius and/or distance ordering: SQL bounding-box prefilter, exact haversine + ordering in memory.
        const rows: Row[] = await db.listing.findMany({
          where,
          include: LISTING_INCLUDE,
          orderBy: [{ postedAt: 'desc' }, { id: 'asc' }],
          take: GEO_CANDIDATE_CAP,
        });
        const c = f.center as { lat: number; lng: number };
        let items = rows.map(toListing);
        if (f.radiusKm !== undefined) items = items.filter((l) => haversineKm(c.lat, c.lng, l.lat, l.lng) <= (f.radiusKm as number));
        if (f.sort === 'nearest') {
          items.sort((a, b) => haversineKm(c.lat, c.lng, a.lat, a.lng) - haversineKm(c.lat, c.lng, b.lat, b.lng));
        }
        return { items: items.slice(f.offset, f.offset + f.limit), total: items.length };
      },
      async findNear(lat, lng, radiusKm, excludeId) {
        const rows: Row[] = await db.listing.findMany({
          where: { ...(excludeId ? { id: { not: excludeId } } : {}), ...geoWhere(lat, lng, radiusKm) },
          include: LISTING_INCLUDE,
          take: GEO_CANDIDATE_CAP,
        });
        return rows.map(toListing).filter((l) => haversineKm(lat, lng, l.lat, l.lng) <= radiusKm);
      },
      async countBySellerSince(sellerId, since) {
        return db.listing.count({ where: { sellerUserId: sellerId, postedAt: { gte: since } } });
      },
      async countSameContentBySeller(sellerId, hash, since) {
        return db.listing.count({ where: { sellerUserId: sellerId, contentHash: hash, postedAt: { gte: since } } });
      },
      async comparablesFor(l): Promise<Comparable[]> {
        const rows: Row[] = await db.listing.findMany({
          where: {
            id: { not: l.id },
            duplicateOfId: null, // a duplicate must not count twice as evidence
            status: 'ACTIVE',
            priceMinor: { gt: 0 },
            currency: l.currency,
            countryCode: l.countryCode,
            categoryKey: l.categoryKey,
          },
          select: { id: true, priceMinor: true, currency: true, countryCode: true, categoryKey: true, postedAt: true },
          orderBy: { postedAt: 'desc' },
          take: 1000,
        });
        return rows.map((c) => ({
          id: c.id,
          priceMinor: c.priceMinor as number,
          currency: c.currency,
          countryCode: c.countryCode,
          categoryKey: c.categoryKey,
          observedAt: c.postedAt,
        }));
      },
      async listForExpiry() {
        const rows: Row[] = await db.listing.findMany({
          where: { status: { in: [...EXPIRY_STATUSES] } },
          include: LISTING_INCLUDE,
        });
        return rows.map(toListing);
      },
    },

    saved: {
      async save(userId, listingId) {
        await db.savedListing.createMany({ data: [{ userId, listingId }], skipDuplicates: true });
      },
      async unsave(userId, listingId) {
        await db.savedListing.deleteMany({ where: { userId, listingId } });
      },
      async listIds(userId) {
        const rows: Row[] = await db.savedListing.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { listingId: true } });
        return rows.map((r) => r.listingId);
      },
      async dismiss(userId, listingId) {
        await db.listingDismissal.createMany({ data: [{ userId, listingId }], skipDuplicates: true });
      },
      async dismissedIds(userId) {
        const rows: Row[] = await db.listingDismissal.findMany({ where: { userId }, select: { listingId: true } });
        return rows.map((r) => r.listingId);
      },
      async bumpCategory(userId, categoryKey) {
        await db.categoryInteraction.upsert({
          where: { userId_categoryKey: { userId, categoryKey } },
          create: { userId, categoryKey, weight: 1 },
          update: { weight: { increment: 1 } },
        });
      },
      async categoryWeights(userId) {
        const rows: Row[] = await db.categoryInteraction.findMany({ where: { userId } });
        const out: Record<string, number> = {};
        for (const r of rows) out[r.categoryKey] = r.weight;
        return out;
      },
      async resetPersonalisation(userId) {
        await db.$transaction([
          db.categoryInteraction.deleteMany({ where: { userId } }),
          db.listingDismissal.deleteMany({ where: { userId } }),
        ]);
      },
    },

    reports: {
      async create(r) {
        try {
          const row = await db.listingReport.create({
            data: {
              id: r.id,
              listingId: r.listingId,
              reporterId: r.reporterId,
              reason: r.reason,
              details: r.details,
              evidenceUrl: r.evidenceUrl,
              status: r.status,
              createdAt: r.createdAt,
            },
          });
          return toReport(row);
        } catch (e) {
          if (isUniqueViolation(e)) return null; // same user, same listing, same reason
          throw e;
        }
      },
      async findById(id) {
        const row = await db.listingReport.findUnique({ where: { id } });
        return row ? toReport(row) : null;
      },
      async distinctOpenReporters(listingId, reasons) {
        const rows: Row[] = await db.listingReport.groupBy({
          by: ['reporterId'],
          where: { listingId, status: 'OPEN', ...(reasons ? { reason: { in: reasons } } : {}) },
        });
        return rows.length;
      },
      async listByStatus(status, offset, limit) {
        const [rows, total] = await Promise.all([
          db.listingReport.findMany({ where: { status }, orderBy: { createdAt: 'asc' }, skip: offset, take: limit }),
          db.listingReport.count({ where: { status } }),
        ]);
        return { items: rows.map(toReport), total };
      },
      async setStatus(id, status) {
        await db.listingReport.updateMany({
          where: { id },
          data: { status, resolvedAt: status === 'ACTIONED' || status === 'DISMISSED' ? new Date() : null },
        });
      },
      async setStatusForListing(listingId, status) {
        await db.listingReport.updateMany({
          where: { listingId, status: 'OPEN' },
          data: { status, resolvedAt: status === 'ACTIONED' || status === 'DISMISSED' ? new Date() : null },
        });
      },
    },

    alerts: {
      async create(a) {
        const row = await db.alertSubscription.create({
          data: {
            id: a.id,
            userId: a.userId,
            name: a.name,
            keywords: a.keywords,
            excludedWords: a.excludedWords,
            categories: a.categories,
            minPriceMinor: a.minPriceMinor,
            maxPriceMinor: a.maxPriceMinor,
            currency: a.currency,
            freeOnly: a.freeOnly,
            radiusKm: a.radiusKm,
            centerLat: a.centerLat,
            centerLng: a.centerLng,
            conditions: a.conditions,
            minDealScore: a.minDealScore,
            sourceKeys: a.sourceKeys,
            frequency: a.frequency,
            active: a.active,
            lastDigestAt: a.lastDigestAt,
            createdAt: a.createdAt,
          },
        });
        return toAlert(row);
      },
      async listByUser(userId) {
        const rows: Row[] = await db.alertSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
        return rows.map(toAlert);
      },
      async findById(id) {
        const row = await db.alertSubscription.findUnique({ where: { id } });
        return row ? toAlert(row) : null;
      },
      async update(id, patch) {
        try {
          const row = await db.alertSubscription.update({
            where: { id },
            data: {
              name: patch.name,
              keywords: patch.keywords,
              excludedWords: patch.excludedWords,
              categories: patch.categories,
              minPriceMinor: patch.minPriceMinor,
              maxPriceMinor: patch.maxPriceMinor,
              currency: patch.currency,
              freeOnly: patch.freeOnly,
              radiusKm: patch.radiusKm,
              centerLat: patch.centerLat,
              centerLng: patch.centerLng,
              conditions: patch.conditions,
              minDealScore: patch.minDealScore,
              sourceKeys: patch.sourceKeys,
              frequency: patch.frequency,
              active: patch.active,
              lastDigestAt: patch.lastDigestAt,
            },
          });
          return toAlert(row);
        } catch (e) {
          if (isNotFound(e)) return null;
          throw e;
        }
      },
      async delete(id) {
        await db.alertSubscription.deleteMany({ where: { id } });
      },
      async listActive() {
        const rows: Row[] = await db.alertSubscription.findMany({ where: { active: true } });
        return rows.map(toAlert);
      },
      async recordDelivery(d) {
        try {
          const row = await db.alertDelivery.create({
            data: {
              id: d.id,
              subscriptionId: d.alertId,
              listingId: d.listingId,
              status: d.status,
              reason: d.reason,
              createdAt: d.createdAt,
            },
          });
          return toDelivery(row);
        } catch (e) {
          if (isUniqueViolation(e)) return null; // the dedup guarantee: one delivery per (alert, listing)
          throw e;
        }
      },
      async setDeliveryStatus(id, status, reason) {
        await db.alertDelivery.updateMany({
          where: { id },
          data: { status, reason: reason ?? null, sentAt: status === 'SENT' ? new Date() : null },
        });
      },
      async countSentSince(userId, since) {
        return db.alertDelivery.count({ where: { status: 'SENT', createdAt: { gte: since }, subscription: { userId } } });
      },
      async listDeliveries(userId, limit) {
        const rows: Row[] = await db.alertDelivery.findMany({
          where: { subscription: { userId } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        return rows.map(toDelivery);
      },
      async listPendingDeliveries() {
        const rows: Row[] = await db.alertDelivery.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
        return rows.map(toDelivery);
      },
    },

    resale: {
      async create(r) {
        const result = calculateResale({ currency: r.currency, ...r.input });
        const row = await db.resaleCalculation.create({
          data: {
            id: r.id,
            userId: r.userId,
            listingId: r.listingId,
            label: r.label,
            currency: r.currency,
            purchaseMinor: r.input.purchaseMinor,
            resaleMinor: r.input.resaleMinor,
            transportMinor: r.input.transportMinor,
            repairMinor: r.input.repairMinor,
            otherMinor: r.input.otherMinor,
            feeBasisPoints: r.input.feeBasisPoints,
            feeFixedMinor: r.input.feeFixedMinor,
            totalCostMinor: result.totalAcquisitionCostMinor,
            grossProfitMinor: result.grossProfitMinor,
            netProfitMinor: result.netProfitMinor,
            marginBasisPoints: result.marginBasisPoints,
            breakEvenMinor: result.breakEvenResaleMinor ?? 0,
            createdAt: r.createdAt,
          },
        });
        return toResale(row);
      },
      async listByUser(userId) {
        const rows: Row[] = await db.resaleCalculation.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
        return rows.map(toResale);
      },
      async findById(id) {
        const row = await db.resaleCalculation.findUnique({ where: { id } });
        return row ? toResale(row) : null;
      },
      async delete(id) {
        await db.resaleCalculation.deleteMany({ where: { id } });
      },
    },

    audit: {
      async add(a) {
        await db.auditLog.create({
          data: {
            id: a.id,
            actorId: a.actorId,
            action: a.action,
            entityType: a.entityType,
            entityId: a.entityId,
            metadata: a.metadata as any,
            createdAt: a.createdAt,
          },
        });
      },
      async list(offset, limit) {
        const [rows, total] = await Promise.all([
          db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
          db.auditLog.count(),
        ]);
        return { items: rows.map(toAudit), total };
      },
    },

    moderation: {
      async add(m) {
        const row = await db.moderationAction.create({
          data: { id: m.id, listingId: m.listingId, moderatorId: m.moderatorId, type: m.type, reason: m.reason, createdAt: m.createdAt },
        });
        return toModeration(row);
      },
      async findById(id) {
        const row = await db.moderationAction.findUnique({ where: { id } });
        return row ? toModeration(row) : null;
      },
      async addAppeal(a) {
        const row = await db.appeal.create({
          data: { id: a.id, actionId: a.moderationId, userId: a.userId, message: a.message, status: a.status, createdAt: a.createdAt },
        });
        return toAppeal(row);
      },
      async listAppeals(status) {
        const rows: Row[] = await db.appeal.findMany({ where: { status }, orderBy: { createdAt: 'asc' } });
        return rows.map(toAppeal);
      },
      async findAppeal(id) {
        const row = await db.appeal.findUnique({ where: { id } });
        return row ? toAppeal(row) : null;
      },
      async setAppealStatus(id, status) {
        await db.appeal.updateMany({ where: { id }, data: { status, resolvedAt: status === 'PENDING' ? null : new Date() } });
      },
      async latestForListing(listingId) {
        const row = await db.moderationAction.findFirst({ where: { listingId }, orderBy: { createdAt: 'desc' } });
        return row ? toModeration(row) : null;
      },
    },

    stats: {
      async stats() {
        const [users, byStatus, bySource, byCountry, duplicates, openReports, byDelivery, sources] = await Promise.all([
          db.user.count(),
          db.listing.groupBy({ by: ['status'], _count: { _all: true } }),
          db.listing.groupBy({ by: ['sourceId'], _count: { _all: true } }),
          db.listing.groupBy({ by: ['countryCode'], _count: { _all: true } }),
          db.listing.count({ where: { duplicateOfId: { not: null } } }),
          db.listingReport.count({ where: { status: 'OPEN' } }),
          db.alertDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
          db.listingSource.findMany({ select: { id: true, key: true } }),
        ]);
        const keyById = new Map<string, string>((sources as Row[]).map((s) => [s.id, s.key]));
        const listingsBySource: Record<string, number> = {};
        for (const r of bySource as Row[]) listingsBySource[keyById.get(r.sourceId) ?? r.sourceId] = r._count._all;
        return {
          users,
          listingsByStatus: countMap(byStatus, 'status'),
          listingsBySource,
          listingsByCountry: countMap(byCountry, 'countryCode'),
          duplicateListings: duplicates,
          openReports,
          deliveriesByStatus: countMap(byDelivery, 'status'),
        };
      },
    },
  };
}

/**
 * Test helper: empties every table. Refuses to run unless the database name ends in `_test`,
 * so it can never wipe a development or production database by mistake.
 */
export async function resetTestDatabase(prisma: PrismaClient): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const dbName = url.split('?')[0].split('/').pop() ?? '';
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to truncate database "${dbName}": the name must end with _test`);
  }
  const db = prisma as any;
  const tables: Array<{ tablename: string }> = await db.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
