import { uploadOwner } from '../storage/keys';
import { CountriesService } from '../countries/countries.service';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { parseBool } from '../common/transform';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CurrentUser, JwtAuthGuard, OptionalAuthGuard } from '../auth/auth';
import { approximateLocation, formatDistance, haversineKm, isValidCoordinate, unitToKm } from '../core/geo';
import { canonicalizeUrl, contentHash, DedupListing, findDuplicates } from '../core/dedup';
import { evaluateExpiry, freshnessLabel, isPubliclyListed, transition, LifecycleEvent } from '../core/lifecycle';
import { assertCurrency, formatMinor, formatPriceLabel, MoneyError, parseMajorToMinor } from '../core/money';
import { assessRisk, RISK_LABELS, SAFETY_GUIDANCE } from '../core/risk';
import { scoreDeal } from '../core/scoring';
import { CONDITIONS, Condition, ListingRec, SourceRec, UserRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';
import { AlertsService } from '../engagement/alerts';

const DAY = 86_400_000;
const urlOpts = { protocols: ['http', 'https'], require_protocol: true };

export class CreateListingDto {
  @IsString() @Length(3, 120) title!: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  /** Defaults to "other" so a quick post needs no category. */
  @IsOptional() @IsString() categoryKey?: string;
  /** Defaults to UNKNOWN. */
  @IsOptional() @IsIn(CONDITIONS) condition?: Condition;
  /** Decimal string in major units. "0" means free. Omit when the price is unknown. */
  @IsOptional() @IsString() @MaxLength(20) price?: string;
  /** Defaults to the currency of the poster's country. */
  @IsOptional() @IsString() currency?: string;
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(100) locationLabel?: string;
  @IsOptional() @IsIn(['IN_APP', 'EMAIL_RELAY', 'EXTERNAL_LINK']) contactMethod?: 'IN_APP' | 'EMAIL_RELAY' | 'EXTERNAL_LINK';
  @IsOptional() @IsUrl(urlOpts) externalUrl?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsUrl({ ...urlOpts, require_tld: false }, { each: true }) imageUrls?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(90) availabilityDays?: number;
}

export class SearchDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @Transform(({ value }) => parseBool(value)) @IsBoolean() freeOnly?: boolean;
  @IsOptional() @IsString() minPrice?: string;
  @IsOptional() @IsString() maxPrice?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsIn(CONDITIONS) condition?: Condition;
  @IsOptional() @Type(() => Number) @IsNumber() lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() lng?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1) @Max(500) radius?: number;
  @IsOptional() @IsIn(['mi', 'km']) unit?: 'mi' | 'km';
  @IsOptional() @IsIn(['newest', 'nearest']) sort?: 'newest' | 'nearest';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsString() cursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
function decodeCursor(c?: string): number {
  if (!c) return 0;
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')).o;
    if (Number.isInteger(o) && o >= 0) return o;
  } catch {
    /* fall through */
  }
  throw new BadRequestException('Invalid cursor');
}

/** How many of the newest matching listings the exceptional-deals feed scores per request. */
const DEAL_SCAN_CAP = 300;
const DEAL_SCAN_BATCH = 50;

const SOURCE_NAMES: Record<string, string> = { direct: 'Posted on Freebie Radar', 'external-link': 'Link shared by a user', spotted: 'Spotted by a member' };
/** Listings with this source key are curb finds reported by a member, not offered by the member. */
export const SPOTTED = 'spotted';

export interface CreateOptions {
  /** A curb find: free, short-lived, photo required, and the poster is not the giver. */
  spotted?: boolean;
}

/** Source-specific freshness rules, in hours. Providers configure their own when added. */
export const EXPIRY_RULES: Record<string, { expireAfterHours: number; retireAfterHours: number }> = {
  direct: { expireAfterHours: 336, retireAfterHours: 168 },
  'external-link': { expireAfterHours: 168, retireAfterHours: 168 },
};
const DEFAULT_RULE = { expireAfterHours: 168, retireAfterHours: 168 };

interface ViewCtx {
  /** Listing ids that currently have an active reservation, when already looked up for a whole page. */
  reserved?: Set<string>;
  viewer?: UserRec;
  center?: { lat: number; lng: number } | null;
  unit?: 'mi' | 'km';
  now: Date;
}

@Injectable()
export class ListingsService {
  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly alerts: AlertsService,
    private readonly countries: CountriesService,
  ) {}

  async create(user: UserRec, dto: CreateListingDto, opts: CreateOptions = {}) {
    const now = new Date();
    if (this.cfg.requireVerifiedEmail && !user.emailVerifiedAt && user.role === 'USER') {
      throw new ForbiddenException('Verify your email before posting. Open Profile and enter the code we sent you.');
    }
    if (opts.spotted) {
      if (!dto.imageUrls?.length) throw new BadRequestException('Add a photo so people can recognise what you spotted.');
      const today = await this.repos.listings.countBySellerSourceSince(user.id, SPOTTED, new Date(now.getTime() - DAY));
      if (today >= this.cfg.spotted.perDay) throw new HttpException('You have reported a lot of finds today. Please try again tomorrow.', HttpStatus.TOO_MANY_REQUESTS);
      dto = { ...dto, price: '0', condition: 'UNKNOWN', contactMethod: 'IN_APP', externalUrl: undefined, availabilityDays: undefined };
    }
    const categoryKey = dto.categoryKey ?? (this.cfg.categories.includes('other') ? 'other' : this.cfg.categories[0]);
    if (!this.cfg.categories.includes(categoryKey)) throw new BadRequestException('Unknown category');
    if (!isValidCoordinate(dto.lat, dto.lng)) throw new BadRequestException('Invalid coordinates');
    for (const raw of dto.imageUrls ?? []) {
      const owner = uploadOwner(raw);
      if (owner !== null && owner !== user.id) throw new BadRequestException('You can only attach photos you uploaded yourself');
      if (!raw.startsWith('https://') && (owner === null || this.cfg.nodeEnv === 'production')) throw new BadRequestException('Photo links must use https');
    }
    const country = (dto.countryCode ?? user.countryCode).toUpperCase();
    const countryRec = await this.countries.getEnabled(country);
    if (!countryRec) throw new BadRequestException(`Country ${country} is not enabled`);

    let currency: string;
    let priceMinor: number | null = null;
    try {
      currency = assertCurrency(dto.currency ?? countryRec.currency);
      if (dto.price !== undefined && dto.price !== '') priceMinor = parseMajorToMinor(dto.price, currency);
    } catch (e) {
      if (e instanceof MoneyError) throw new BadRequestException(e.message);
      throw e;
    }
    if (dto.contactMethod === 'EXTERNAL_LINK' && !dto.externalUrl) throw new BadRequestException('externalUrl is required for EXTERNAL_LINK contact');

    const canonicalUrl = dto.externalUrl ? canonicalizeUrl(dto.externalUrl) : null;
    const description = dto.description?.trim() ?? '';
    const hash = contentHash(dto.title, description);

    const rec: ListingRec = {
      id: randomUUID(),
      sourceKey: opts.spotted ? SPOTTED : dto.externalUrl ? 'external-link' : 'direct',
      externalId: null,
      sellerUserId: user.id,
      title: dto.title.trim(),
      description,
      categoryKey,
      condition: dto.condition ?? 'UNKNOWN',
      priceMinor,
      currency,
      isFree: priceMinor === 0,
      countryCode: country,
      lat: dto.lat,
      lng: dto.lng,
      locationLabel: dto.locationLabel ?? null,
      contactMethod: dto.contactMethod ?? 'IN_APP',
      externalUrl: dto.externalUrl ?? null,
      canonicalUrl,
      status: 'ACTIVE',
      riskLevel: 'NO_MAJOR_SIGNALS',
      riskSignals: [],
      contentHash: hash,
      duplicateOfId: null,
      isPromoted: false,
      imageUrls: dto.imageUrls ?? [],
      postedAt: now,
      lastConfirmedAt: now,
      expiresAt: opts.spotted ? new Date(now.getTime() + this.cfg.spotted.ttlHours * 3_600_000) : new Date(now.getTime() + (dto.availabilityDays ?? 14) * DAY),
    };

    // Duplicate handling: a strong duplicate from the same seller is rejected; from another seller it is linked.
    const nearby = await this.repos.listings.findNear(rec.lat, rec.lng, 2);
    const toDedup = (l: ListingRec): DedupListing => ({
      id: l.id, sourceId: l.sourceKey, externalId: l.externalId, canonicalUrl: l.canonicalUrl,
      title: l.title, description: l.description, priceMinor: l.priceMinor, currency: l.currency, lat: l.lat, lng: l.lng, sellerUserId: l.sellerUserId,
    });
    const urlMatches = canonicalUrl ? (await this.repos.listings.search({ publicOnly: false, sort: 'newest', offset: 0, limit: 1000 })).items.filter((l) => l.canonicalUrl === canonicalUrl) : [];
    const dup = findDuplicates(toDedup(rec), [...nearby, ...urlMatches.filter((u) => !nearby.some((n) => n.id === u.id))].map(toDedup));
    if (dup.autoLinkable) {
      const original = [...nearby, ...urlMatches].find((l) => l.id === dup.autoLinkable!.listing.id)!;
      if (original.sellerUserId === user.id) throw new ConflictException('This looks like a duplicate of one of your existing listings');
      rec.duplicateOfId = original.id;
    }

    // Risk assessment from rules only.
    const comps = await this.repos.listings.comparablesFor(rec);
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const dayAgo = new Date(now.getTime() - DAY);
    const sorted = comps.map((c) => c.priceMinor).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const risk = assessRisk({
      title: rec.title,
      description: rec.description,
      priceMinor: rec.priceMinor,
      isFree: rec.isFree,
      condition: rec.condition,
      sellerAccountAgeHours: (now.getTime() - user.createdAt.getTime()) / 3_600_000,
      sellerListingsLast24h: await this.repos.listings.countBySellerSince(user.id, dayAgo),
      sameContentBySeller: await this.repos.listings.countSameContentBySeller(user.id, hash, weekAgo),
      comparableMedianMinor: median,
      comparableSampleSize: comps.length,
    });
    rec.riskLevel = risk.level;
    rec.riskSignals = risk.signals;
    if (risk.level === 'UNDER_REVIEW') rec.status = 'UNDER_REVIEW'; // held for human review, never auto-removed

    const saved = await this.repos.listings.insert(rec);
    await this.audit(user.id, 'LISTING_CREATED', saved.id, { source: saved.sourceKey, risk: saved.riskLevel });
    if (saved.status === 'ACTIVE' && !saved.duplicateOfId) await this.alerts.processNewListing(saved);
    return this.toOwnerView(saved, { viewer: user, now });
  }

  async search(q: SearchDto, viewer?: UserRec) {
    const unit = q.unit ?? viewer?.prefs.distanceUnit ?? 'km';
    const center = this.resolveCenter(q, viewer);
    const filter = this.buildFilter(q, viewer, center);
    const blockedSellers = viewer ? await this.repos.blocks.blockedIds(viewer.id) : [];
    const { items, total } = await this.repos.listings.search({ ...filter, excludeSellerIds: blockedSellers });
    const reserved = new Set(await this.repos.claims.activeListingIds(items.map((l) => l.id)));
    const ctx: ViewCtx = { viewer, center, unit, now: new Date(), reserved };
    const dismissed = viewer ? new Set(await this.repos.saved.dismissedIds(viewer.id)) : new Set<string>();
    const views = await Promise.all(items.filter((l) => !dismissed.has(l.id)).map((l) => this.toPublic(l, ctx)));
    const next = filter.offset + filter.limit;
    return { items: views, total, nextCursor: next < total ? encodeCursor(next) : null };
  }

  async get(id: string, viewer?: UserRec) {
    const l = await this.repos.listings.findById(id);
    if (!l) throw new NotFoundException('Listing not found');
    const privileged = viewer && (viewer.id === l.sellerUserId || viewer.role === 'MODERATOR' || viewer.role === 'ADMIN');
    if (!isPubliclyListed(l.status) && !privileged) throw new NotFoundException('Listing not found');
    if (viewer && !privileged && l.sellerUserId && (await this.repos.blocks.blockedIds(viewer.id)).includes(l.sellerUserId)) throw new NotFoundException('Listing not found');
    if (viewer) await this.repos.saved.bumpCategory(viewer.id, l.categoryKey);
    const view = await this.toPublic(l, { viewer, center: viewer ? this.homeCenter(viewer) : null, unit: viewer?.prefs.distanceUnit, now: new Date() });
    // How many items this member has given away, so a newcomer can see a record. Never shown for curb finds or outside sources.
    const giver = l.sellerUserId && l.sourceKey !== SPOTTED ? { itemsGiven: (await this.repos.claims.tally(l.sellerUserId)).given } : null;
    return { ...view, giver, safetyGuidance: SAFETY_GUIDANCE };
  }

  /** Hides a seller's listings from the blocker's feeds, search and saved list. The seller is not told. */
  async blockSeller(user: UserRec, listingId: string) {
    const l = await this.repos.listings.findById(listingId);
    if (!l || !isPubliclyListed(l.status)) throw new NotFoundException('Listing not found');
    if (!l.sellerUserId) throw new BadRequestException('This listing comes from an outside source, so there is no seller account to block.');
    if (l.sellerUserId === user.id) throw new BadRequestException('You cannot block yourself.');
    await this.repos.blocks.add(user.id, l.sellerUserId);
    return { blocked: true };
  }

  async listBlocks(user: UserRec) {
    const rows = await this.repos.blocks.list(user.id);
    const items = await Promise.all(rows.map(async (b) => ({ userId: b.blockedId, displayName: (await this.repos.users.findById(b.blockedId))?.displayName ?? 'Unknown user', blockedAt: b.createdAt.toISOString() })));
    return { items };
  }

  async unblock(user: UserRec, userId: string) {
    if (!(await this.repos.blocks.remove(user.id, userId))) throw new NotFoundException('You have not blocked that user.');
    return { blocked: false };
  }

  async mine(user: UserRec) {
    const { items } = await this.repos.listings.search({ sellerUserId: user.id, publicOnly: false, sort: 'newest', offset: 0, limit: 200 });
    return { items: await Promise.all(items.map((l) => this.toOwnerView(l, { viewer: user, now: new Date() }))) };
  }

  /** Public views for a set of ids, skipping anything no longer publicly listed. No side effects. */
  async viewMany(ids: string[], viewer: UserRec) {
    const ctx: ViewCtx = { viewer, center: this.homeCenter(viewer), unit: viewer.prefs.distanceUnit, now: new Date() };
    const found = await Promise.all(ids.map((id) => this.repos.listings.findById(id)));
    const blocked = new Set(await this.repos.blocks.blockedIds(viewer.id));
    const visible = found.filter((l): l is ListingRec => !!l && isPubliclyListed(l.status) && !(l.sellerUserId && blocked.has(l.sellerUserId)));
    return Promise.all(visible.map((l) => this.toPublic(l, ctx)));
  }

  /** Seller confirms availability (positive evidence) or marks it unavailable (terminal until a moderator restores). */
  async sellerAvailability(user: UserRec, id: string, event: 'SELLER_CONFIRMED' | 'SELLER_MARKED_UNAVAILABLE') {
    const l = await this.repos.listings.findById(id);
    if (!l || l.sellerUserId !== user.id) throw new NotFoundException('Listing not found');
    const next = this.safeTransition(l.status, event);
    const now = new Date();
    const patch: Partial<ListingRec> = { status: next };
    if (event === 'SELLER_CONFIRMED') patch.lastConfirmedAt = now;
    const updated = (await this.repos.listings.update(id, patch))!;
    await this.audit(user.id, `AVAILABILITY_${event}`, id, { from: l.status, to: next });
    return this.toOwnerView(updated, { viewer: user, now });
  }

  /** Background job body: moves stale listings along the lifecycle. Idempotent. */
  async runExpiry(now = new Date()) {
    let expired = 0;
    let retired = 0;
    // Partner sources carry their own freshness settings (editable per source); built-in sources use the static rules.
    const partner = new Map((await this.repos.sources.list()).filter((x) => x.kind === 'API_PROVIDER').map((x) => [x.key, x]));
    for (const l of await this.repos.listings.listForExpiry()) {
      const src = partner.get(l.sourceKey);
      const rule = src ? { expireAfterHours: src.expireAfterHours, retireAfterHours: src.retireAfterHours } : EXPIRY_RULES[l.sourceKey] ?? DEFAULT_RULE;
      const ev = evaluateExpiry({ status: l.status, lastConfirmedAt: l.lastConfirmedAt, expiresAt: l.expiresAt }, rule, now);
      if (!ev) continue;
      let next = transition(l.status, ev);
      // A curb find that has run its day is simply gone: no "may no longer be available" stage.
      if (l.sourceKey === SPOTTED && ev === 'AUTO_EXPIRED') next = transition(next, 'AUTO_RETIRED');
      await this.repos.listings.update(l.id, { status: next });
      await this.audit(null, `AVAILABILITY_${ev}`, l.id, { from: l.status, to: next });
      if (ev === 'AUTO_EXPIRED') expired++;
      else retired++;
    }
    return { expired, retired };
  }

  // ---- feeds ----
  async freeNearMe(q: SearchDto, viewer?: UserRec) {
    return this.search({ ...q, freeOnly: true, sort: 'nearest' }, viewer);
  }

  /**
   * Exceptional deals are ranked across a scan of the newest matching listings, not just the first page of
   * search results: every candidate is scored, those at or above `minScore` are sorted best first, and
   * `limit`/`cursor` page through that ranked list. The scan is capped (see DEAL_SCAN_CAP) and the response
   * says when it was cut short. Production should replace this with stored scores.
   */
  async exceptionalDeals(q: SearchDto, viewer?: UserRec, minScore = 75) {
    const unit = q.unit ?? viewer?.prefs.distanceUnit ?? 'km';
    const center = this.resolveCenter(q, viewer);
    const ctx: ViewCtx = { viewer, center, unit, now: new Date() };
    const blocked = viewer ? await this.repos.blocks.blockedIds(viewer.id) : [];
    const dismissed = viewer ? new Set(await this.repos.saved.dismissedIds(viewer.id)) : new Set<string>();
    const qualifying: Awaited<ReturnType<ListingsService['toPublic']>>[] = [];
    let scanned = 0;
    let total = 0;
    while (scanned < DEAL_SCAN_CAP) {
      const filter = this.buildFilter({ ...q, limit: DEAL_SCAN_BATCH, cursor: encodeCursor(scanned) }, viewer, center);
      const { items, total: t } = await this.repos.listings.search({ ...filter, excludeSellerIds: blocked });
      total = t;
      if (!items.length) break;
      for (const l of items) {
        if (dismissed.has(l.id)) continue;
        const view = await this.toPublic(l, ctx);
        if (view.dealScore && view.dealScore.score >= minScore) qualifying.push(view);
      }
      scanned += items.length;
      if (scanned >= total) break;
    }
    qualifying.sort((a, b) => b.dealScore!.score - a.dealScore!.score || a.id.localeCompare(b.id));
    const limit = q.limit ?? 20;
    const start = decodeCursor(q.cursor);
    const items = qualifying.slice(start, start + limit);
    const next = start + limit;
    return {
      items,
      total: qualifying.length,
      nextCursor: next < qualifying.length ? encodeCursor(next) : null,
      scanned,
      truncated: scanned < total,
      note: 'Only listings with enough comparable-price evidence can have a Deal Score.',
    };
  }

  async recommended(viewer: UserRec, q: SearchDto) {
    const weights = viewer.prefs.personalisationEnabled ? await this.repos.saved.categoryWeights(viewer.id) : {};
    const top = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
    const page = await this.search({ ...q, category: top?.[0] ?? q.category, limit: q.limit ?? 20 }, viewer);
    const saved = new Set(await this.repos.saved.listIds(viewer.id));
    const items = page.items.filter((i) => !saved.has(i.id));
    return {
      items,
      reason: top ? `Recommended because you recently looked at ${top[0]} listings.` : 'Recently added listings near you. Browse or save listings to personalise this feed.',
      personalisation: viewer.prefs.personalisationEnabled ? 'on' : 'off',
    };
  }

  // ---- internals ----
  private safeTransition(from: ListingRec['status'], event: LifecycleEvent) {
    try {
      return transition(from, event);
    } catch {
      throw new ConflictException(`That action is not available while the listing is ${from.toLowerCase().replace(/_/g, ' ')}`);
    }
  }

  private homeCenter(u: UserRec) {
    return u.prefs.homeLat !== null && u.prefs.homeLng !== null ? { lat: u.prefs.homeLat, lng: u.prefs.homeLng } : null;
  }

  private resolveCenter(q: SearchDto, viewer?: UserRec) {
    if ((q.lat === undefined) !== (q.lng === undefined)) throw new BadRequestException('lat and lng must be provided together');
    if (q.lat !== undefined && q.lng !== undefined) {
      if (!isValidCoordinate(q.lat, q.lng)) throw new BadRequestException('Invalid coordinates');
      return { lat: q.lat, lng: q.lng };
    }
    return viewer ? this.homeCenter(viewer) : null;
  }

  private buildFilter(q: SearchDto, viewer: UserRec | undefined, center: { lat: number; lng: number } | null) {
    let currency: string | undefined;
    let min: number | undefined;
    let max: number | undefined;
    try {
      if (q.minPrice !== undefined || q.maxPrice !== undefined) {
        currency = assertCurrency(q.currency ?? this.cfg.defaultCurrency);
        if (q.minPrice !== undefined) min = parseMajorToMinor(q.minPrice, currency);
        if (q.maxPrice !== undefined) max = parseMajorToMinor(q.maxPrice, currency);
      }
    } catch (e) {
      if (e instanceof MoneyError) throw new BadRequestException(e.message);
      throw e;
    }
    if (q.category && !this.cfg.categories.includes(q.category)) throw new BadRequestException('Unknown category');
    const unit = q.unit ?? viewer?.prefs.distanceUnit ?? 'km';
    if (q.radius !== undefined && !center) throw new BadRequestException('A radius needs a location: pass lat/lng or set a home location');
    const sort = q.sort ?? (center ? 'nearest' : 'newest');
    if (sort === 'nearest' && !center) throw new BadRequestException('Sorting by distance needs a location');
    return {
      q: q.q,
      categoryKey: q.category,
      freeOnly: q.freeOnly,
      minPriceMinor: min,
      maxPriceMinor: max,
      currency,
      condition: q.condition,
      center: center ?? undefined,
      radiusKm: q.radius !== undefined ? unitToKm(q.radius, unit) : undefined,
      sort,
      publicOnly: true,
      offset: decodeCursor(q.cursor),
      limit: q.limit ?? 20,
    } as const;
  }

  private async toPublic(l: ListingRec, ctx: ViewCtx) {
    const locale = ctx.viewer?.locale ?? 'en-US';
    const unit = ctx.unit ?? 'km';
    const approx = approximateLocation(l.lat, l.lng);
    const km = ctx.center ? haversineKm(ctx.center.lat, ctx.center.lng, l.lat, l.lng) : null;
    const comps = await this.repos.listings.comparablesFor(l);
    const score = scoreDeal(
      { id: l.id, priceMinor: l.priceMinor, currency: l.currency, countryCode: l.countryCode, categoryKey: l.categoryKey, condition: l.condition, status: l.status, risk: l.riskLevel, lastConfirmedAt: l.lastConfirmedAt },
      comps,
      { distanceKm: km, now: ctx.now },
    );
    const fresh = freshnessLabel(ctx.now, l.postedAt, l.lastConfirmedAt, l.status, locale);
    const src = (await this.sourceInfo()).get(l.sourceKey);
    const ev = score.evidence;
    return {
      id: l.id,
      title: l.title,
      description: l.description,
      category: l.categoryKey,
      condition: l.condition,
      price: { minor: l.priceMinor, currency: l.currency, label: formatPriceLabel(l.priceMinor, l.currency, locale), isFree: l.isFree && l.priceMinor === 0 },
      location: { ...approx, label: l.locationLabel, precision: 'approximate' as const },
      distance: km === null ? null : { km: Math.round(km * 10) / 10, label: formatDistance(km, unit, locale) },
      source: {
        key: l.sourceKey,
        name: SOURCE_NAMES[l.sourceKey] ?? src?.name ?? l.sourceKey,
        verified: false,
        // Shown wherever a partner's listing appears; the partner's agreement says how it must be credited.
        attribution: src?.kind === 'API_PROVIDER' ? { text: src.attribution, url: src.attributionUrl } : null,
      },
      freshness: fresh,
      status: l.status,
      risk: { level: l.riskLevel, label: RISK_LABELS[l.riskLevel], signals: l.riskSignals.map((s) => s.message) },
      dealScore: score.score === null ? null : {
        score: score.score,
        explanation: score.explanation,
        factors: score.factors,
        evidence: { sampleSize: ev.sampleSize, median: ev.medianMinor === null ? null : formatMinor(ev.medianMinor, l.currency, locale), range: ev.lowMinor === null ? null : `${formatMinor(ev.lowMinor, l.currency, locale)}–${formatMinor(ev.highMinor!, l.currency, locale)}`, limitations: ev.limitations },
      },
      dealScoreNote: score.score === null ? score.explanation : undefined,
      sponsored: l.isPromoted,
      images: l.imageUrls,
      externalUrl: l.externalUrl,
      contactMethod: l.contactMethod,
      /** GIVEN: a member is giving it. SPOTTED: a member saw it on the curb. EXTERNAL: it comes from an outside source. */
      kind: (l.sourceKey === SPOTTED ? 'SPOTTED' : l.sellerUserId ? 'GIVEN' : 'EXTERNAL') as 'SPOTTED' | 'GIVEN' | 'EXTERNAL',
      /** True when a person who owns the item posted it and it is open, so in-app messaging is possible. */
      messageable: l.sellerUserId !== null && l.status === 'ACTIVE' && l.sourceKey !== SPOTTED,
      /** A free item from a member that can be reserved with "I'll take it". */
      claimable: l.sellerUserId !== null && l.sourceKey !== SPOTTED && l.status === 'ACTIVE' && l.isFree && l.priceMinor === 0,
      reserved: ctx.reserved ? ctx.reserved.has(l.id) : !!(await this.repos.claims.activeForListing(l.id)),
    };
  }

  private sourceCache: { at: number; byKey: Map<string, SourceRec> } | null = null;
  private async sourceInfo(): Promise<Map<string, SourceRec>> {
    if (this.sourceCache && Date.now() - this.sourceCache.at < 30_000) return this.sourceCache.byKey;
    const byKey = new Map((await this.repos.sources.list()).map((x) => [x.key, x]));
    this.sourceCache = { at: Date.now(), byKey };
    return byKey;
  }

  private async toOwnerView(l: ListingRec, ctx: ViewCtx) {
    return { ...(await this.toPublic(l, ctx)), expiresAt: l.expiresAt, isOwner: true };
  }

  private async audit(actorId: string | null, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.repos.audit.add({ id: randomUUID(), actorId, action, entityType: 'Listing', entityId, metadata, createdAt: new Date() });
  }
}

@Controller()
export class ListingsController {
  constructor(private readonly svc: ListingsService) {}

  @UseGuards(OptionalAuthGuard)
  @Get('listings')
  search(@Query() q: SearchDto, @CurrentUser() viewer?: UserRec) {
    return this.svc.search(q, viewer);
  }

  @UseGuards(JwtAuthGuard)
  @Get('listings/mine')
  mine(@CurrentUser() user: UserRec) {
    return this.svc.mine(user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('listings')
  create(@CurrentUser() user: UserRec, @Body() dto: CreateListingDto) {
    return this.svc.create(user, dto);
  }

  @UseGuards(OptionalAuthGuard)
  @Get('listings/:id')
  get(@Param('id') id: string, @CurrentUser() viewer?: UserRec) {
    return this.svc.get(id, viewer);
  }

  @UseGuards(JwtAuthGuard)
  @Post('listings/:id/block-seller')
  blockSeller(@Param('id') id: string, @CurrentUser() user: UserRec) {
    return this.svc.blockSeller(user, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/blocks')
  blocks(@CurrentUser() user: UserRec) {
    return this.svc.listBlocks(user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me/blocks/:userId')
  unblock(@Param('userId') userId: string, @CurrentUser() user: UserRec) {
    return this.svc.unblock(user, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('listings/:id/confirm')
  confirm(@Param('id') id: string, @CurrentUser() user: UserRec) {
    return this.svc.sellerAvailability(user, id, 'SELLER_CONFIRMED');
  }

  @UseGuards(JwtAuthGuard)
  @Post('listings/:id/unavailable')
  unavailable(@Param('id') id: string, @CurrentUser() user: UserRec) {
    return this.svc.sellerAvailability(user, id, 'SELLER_MARKED_UNAVAILABLE');
  }

  @UseGuards(OptionalAuthGuard)
  @Get('feed/free-near-me')
  free(@Query() q: SearchDto, @CurrentUser() viewer?: UserRec) {
    return this.svc.freeNearMe(q, viewer);
  }

  @UseGuards(OptionalAuthGuard)
  @Get('feed/exceptional-deals')
  deals(@Query() q: SearchDto, @CurrentUser() viewer?: UserRec) {
    return this.svc.exceptionalDeals(q, viewer);
  }

  @UseGuards(JwtAuthGuard)
  @Get('feed/recommended')
  recommended(@Query() q: SearchDto, @CurrentUser() viewer: UserRec) {
    return this.svc.recommended(viewer, q);
  }
}

