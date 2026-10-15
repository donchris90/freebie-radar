import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CurrentUser, JwtAuthGuard } from '../auth/auth';
import { isValidCoordinate } from '../core/geo';
import { assertCurrency, formatPriceLabel, MoneyError } from '../core/money';
import { AlertCandidate, inQuietHours, isDigestDue, localHour, matchesAlert, planDelivery } from '../core/alerts';
import { scoreDeal } from '../core/scoring';
import { AlertFrequency, AlertRec, CONDITIONS, Condition, ListingRec, UserRec } from '../domain/models';
import { PUSH_SENDER, PushSender, REPOS, Repos } from '../domain/ports';

const words = { each: true } as const;

export class CreateAlertDto {
  @IsString() @Length(1, 60) name!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString(words) @MaxLength(50, words) keywords?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString(words) @MaxLength(50, words) excludedWords?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString(words) categories?: string[];
  /** Minor units. Price bounds need a currency. */
  @IsOptional() @IsInt() @Min(0) minPriceMinor?: number;
  @IsOptional() @IsInt() @Min(0) maxPriceMinor?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsBoolean() freeOnly?: boolean;
  @IsOptional() @IsNumber() @Min(0.1) @Max(500) radiusKm?: number;
  @IsOptional() @IsNumber() centerLat?: number;
  @IsOptional() @IsNumber() centerLng?: number;
  @IsOptional() @IsArray() @IsIn(CONDITIONS, words) conditions?: Condition[];
  @IsOptional() @IsInt() @Min(0) @Max(100) minDealScore?: number;
  @IsOptional() @IsArray() @IsString(words) sourceKeys?: string[];
  @IsOptional() @IsIn(['IMMEDIATE', 'HOURLY_DIGEST', 'DAILY_DIGEST']) frequency?: AlertFrequency;
}

export class UpdateAlertDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsIn(['IMMEDIATE', 'HOURLY_DIGEST', 'DAILY_DIGEST']) frequency?: AlertFrequency;
}

/** Default sender: reports "not configured" instead of pretending a notification was delivered. */
@Injectable()
export class UnconfiguredPushSender implements PushSender {
  isConfigured() { return false; }
  async send() { return { sent: false, reason: 'Push provider is not configured' }; }
}

/**
 * Expo push sender. Enabled with EXPO_PUSH_ENABLED=true. NOTE: not exercised in the build sandbox
 * (outbound network is restricted); verify against Expo's service in a real environment.
 */
@Injectable()
export class ExpoPushSender implements PushSender {
  isConfigured() { return process.env.EXPO_PUSH_ENABLED === 'true'; }
  async send(msg: { token: string; title: string; body: string; data?: Record<string, string> }) {
    if (!this.isConfigured()) return { sent: false, reason: 'Push provider is not configured' };
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.EXPO_PUSH_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_PUSH_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify({ to: msg.token, title: msg.title, body: msg.body, data: msg.data }),
      });
      if (!res.ok) return { sent: false, reason: `Push service responded ${res.status}` };
      return { sent: true };
    } catch (e) {
      return { sent: false, reason: `Push request failed: ${(e as Error).message}` };
    }
  }
}

const DAY = 86_400_000;

@Injectable()
export class AlertsService {
  private readonly log = new Logger('Alerts');
  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  async create(user: UserRec, dto: CreateAlertDto) {
    const existing = await this.repos.alerts.listByUser(user.id);
    const limit = this.cfg.alertLimits[user.tier];
    if (existing.length >= limit) throw new ForbiddenException(`Your plan allows up to ${limit} saved alerts`);

    const hasPrice = dto.minPriceMinor !== undefined || dto.maxPriceMinor !== undefined;
    let currency: string | null = null;
    try {
      if (dto.currency) currency = assertCurrency(dto.currency);
    } catch (e) {
      if (e instanceof MoneyError) throw new BadRequestException(e.message);
      throw e;
    }
    if (hasPrice && !currency) throw new BadRequestException('A currency is required with price limits');
    if (dto.minPriceMinor !== undefined && dto.maxPriceMinor !== undefined && dto.minPriceMinor > dto.maxPriceMinor) throw new BadRequestException('Minimum price is above the maximum');
    if (dto.radiusKm !== undefined) {
      if (dto.centerLat === undefined || dto.centerLng === undefined) throw new BadRequestException('A radius needs a centre point');
      if (!isValidCoordinate(dto.centerLat, dto.centerLng)) throw new BadRequestException('Invalid coordinates');
    }
    for (const c of dto.categories ?? []) if (!this.cfg.categories.includes(c)) throw new BadRequestException(`Unknown category: ${c}`);
    const hasAnyCriteria = (dto.keywords?.length ?? 0) > 0 || (dto.categories?.length ?? 0) > 0 || dto.freeOnly || hasPrice || dto.radiusKm !== undefined || dto.minDealScore !== undefined;
    if (!hasAnyCriteria) throw new BadRequestException('Add at least one criterion so the alert is not triggered by every listing');

    const rec: AlertRec = {
      id: randomUUID(),
      userId: user.id,
      name: dto.name.trim(),
      keywords: dto.keywords ?? [],
      excludedWords: dto.excludedWords ?? [],
      categories: dto.categories ?? [],
      minPriceMinor: dto.minPriceMinor ?? null,
      maxPriceMinor: dto.maxPriceMinor ?? null,
      currency,
      freeOnly: dto.freeOnly ?? false,
      radiusKm: dto.radiusKm ?? null,
      centerLat: dto.centerLat ?? null,
      centerLng: dto.centerLng ?? null,
      conditions: dto.conditions ?? [],
      minDealScore: dto.minDealScore ?? null,
      sourceKeys: dto.sourceKeys ?? [],
      frequency: dto.frequency ?? 'IMMEDIATE',
      active: true,
      lastDigestAt: null,
      createdAt: new Date(),
    };
    return this.repos.alerts.create(rec);
  }

  list(user: UserRec) {
    return this.repos.alerts.listByUser(user.id);
  }

  async update(user: UserRec, id: string, dto: UpdateAlertDto) {
    const a = await this.owned(user, id);
    return this.repos.alerts.update(a.id, { ...(dto.active !== undefined && { active: dto.active }), ...(dto.name && { name: dto.name }), ...(dto.frequency && { frequency: dto.frequency }) });
  }

  async remove(user: UserRec, id: string) {
    const a = await this.owned(user, id);
    await this.repos.alerts.delete(a.id);
    return { deleted: true };
  }

  history(user: UserRec) {
    return this.repos.alerts.listDeliveries(user.id, 50);
  }

  private async owned(user: UserRec, id: string) {
    const a = await this.repos.alerts.findById(id);
    // 404 rather than 403 so other users' alert ids are not confirmable.
    if (!a || a.userId !== user.id) throw new NotFoundException('Alert not found');
    return a;
  }

  /** Called for each newly listed ACTIVE listing. Safe to call repeatedly: delivery rows are unique per alert+listing. */
  async processNewListing(l: ListingRec, now = new Date()) {
    const comps = await this.repos.listings.comparablesFor(l);
    const score = scoreDeal({ id: l.id, priceMinor: l.priceMinor, currency: l.currency, countryCode: l.countryCode, categoryKey: l.categoryKey, condition: l.condition, status: l.status, risk: l.riskLevel, lastConfirmedAt: l.lastConfirmedAt }, comps, { now });
    const candidate: AlertCandidate = {
      id: l.id, title: l.title, description: l.description, status: l.status, priceMinor: l.priceMinor, currency: l.currency, isFree: l.isFree,
      categoryKey: l.categoryKey, condition: l.condition, lat: l.lat, lng: l.lng, sourceKey: l.sourceKey, dealScore: score.score,
    };
    const users = new Map<string, UserRec | null>();
    const result = { matched: 0, sent: 0, deferred: 0, skipped: 0, duplicates: 0 };

    for (const a of await this.repos.alerts.listActive()) {
      if (a.userId === l.sellerUserId) continue; // never alert people about their own listings
      if (!matchesAlert(a, candidate).match) continue;
      let user = users.get(a.userId);
      if (user === undefined) { user = await this.repos.users.findById(a.userId); users.set(a.userId, user); }
      if (!user || user.status !== 'ACTIVE') continue;
      if (l.sellerUserId && (await this.repos.blocks.blockedIds(user.id)).includes(l.sellerUserId)) continue; // they blocked this seller
      result.matched++;

      const delivery = await this.repos.alerts.recordDelivery({ id: randomUUID(), alertId: a.id, listingId: l.id, status: 'PENDING', reason: null, createdAt: now });
      if (!delivery) { result.duplicates++; continue; }

      const decision = planDelivery({
        frequency: a.frequency,
        now,
        timeZone: user.timeZone,
        pushEnabled: user.prefs.pushEnabled && !!user.prefs.pushToken,
        quietHoursStart: user.prefs.quietHoursStart,
        quietHoursEnd: user.prefs.quietHoursEnd,
        sentLast24h: await this.repos.alerts.countSentSince(user.id, new Date(now.getTime() - DAY)),
        maxPerDay: user.prefs.maxPushPerDay,
        lastDigestAt: a.lastDigestAt,
      });
      if (decision.action === 'SKIP') {
        await this.repos.alerts.setDeliveryStatus(delivery.id, decision.reason === 'DAILY_LIMIT' ? 'SKIPPED_LIMIT' : 'SKIPPED_PREFERENCES', decision.reason);
        result.skipped++;
      } else if (decision.action === 'SEND_NOW') {
        const ok = await this.sendOne(user, a, l);
        await this.repos.alerts.setDeliveryStatus(delivery.id, ok.sent ? 'SENT' : 'FAILED', ok.reason);
        if (ok.sent) result.sent++; else result.skipped++;
      } else {
        await this.repos.alerts.setDeliveryStatus(delivery.id, 'PENDING', decision.action === 'DEFER_QUIET_HOURS' ? 'quiet hours' : 'digest');
        result.deferred++;
      }
    }
    return result;
  }

  /** Background job body: sends deferred (quiet-hours) alerts and due digests. */
  async dispatchPending(now = new Date()) {
    const pending = await this.repos.alerts.listPendingDeliveries();
    let sent = 0;
    const byAlert = new Map<string, typeof pending>();
    for (const d of pending) byAlert.set(d.alertId, [...(byAlert.get(d.alertId) ?? []), d]);

    for (const [alertId, deliveries] of byAlert) {
      const a = await this.repos.alerts.findById(alertId);
      const user = a ? await this.repos.users.findById(a.userId) : null;
      if (!a || !user || user.status !== 'ACTIVE' || !a.active) continue;
      if (!user.prefs.pushEnabled || !user.prefs.pushToken) {
        for (const d of deliveries) await this.repos.alerts.setDeliveryStatus(d.id, 'SKIPPED_PREFERENCES', 'push disabled');
        continue;
      }
      if (a.frequency === 'IMMEDIATE') {
        if (inQuietHours(localHour(now, user.timeZone), user.prefs.quietHoursStart, user.prefs.quietHoursEnd)) continue;
      } else if (!isDigestDue(a.frequency, now, a.lastDigestAt)) continue;

      const sentToday = await this.repos.alerts.countSentSince(user.id, new Date(now.getTime() - DAY));
      if (sentToday >= user.prefs.maxPushPerDay) {
        for (const d of deliveries) await this.repos.alerts.setDeliveryStatus(d.id, 'SKIPPED_LIMIT', 'daily limit');
        continue;
      }
      const listings = (await Promise.all(deliveries.map((d) => this.repos.listings.findById(d.listingId)))).filter((x): x is ListingRec => !!x && x.status === 'ACTIVE');
      // Listings that went away while waiting are not announced.
      const live = new Set(listings.map((x) => x.id));
      for (const d of deliveries) if (!live.has(d.listingId)) await this.repos.alerts.setDeliveryStatus(d.id, 'SKIPPED_PREFERENCES', 'listing no longer active');
      if (listings.length === 0) continue;

      const res = a.frequency === 'IMMEDIATE' && listings.length === 1
        ? await this.sendOne(user, a, listings[0])
        : await this.push.send({ token: user.prefs.pushToken, title: `${a.name}: ${listings.length} new listing${listings.length === 1 ? '' : 's'}`, body: listings.slice(0, 3).map((x) => x.title).join(' · '), data: { alertId: a.id } });
      for (const d of deliveries.filter((x) => live.has(x.listingId))) await this.repos.alerts.setDeliveryStatus(d.id, res.sent ? 'SENT' : 'FAILED', res.reason);
      if (res.sent) { sent++; if (a.frequency !== 'IMMEDIATE') await this.repos.alerts.update(a.id, { lastDigestAt: now }); }
    }
    return { sent };
  }

  private async sendOne(user: UserRec, a: AlertRec, l: ListingRec) {
    if (!user.prefs.pushToken) return { sent: false, reason: 'No push token registered' };
    const price = formatPriceLabel(l.priceMinor, l.currency, user.locale);
    const res = await this.push.send({ token: user.prefs.pushToken, title: `${a.name}: ${l.title}`, body: `${price}${l.locationLabel ? ` · ${l.locationLabel}` : ''}`, data: { listingId: l.id, alertId: a.id } });
    if (!res.sent) this.log.warn(`Push not sent for alert ${a.id}: ${res.reason}`);
    return res;
  }
}

@Controller('alerts')
@UseGuards(JwtAuthGuard)
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}
  @Post() create(@CurrentUser() u: UserRec, @Body() dto: CreateAlertDto) { return this.svc.create(u, dto); }
  @Get() list(@CurrentUser() u: UserRec) { return this.svc.list(u); }
  @Get('history') history(@CurrentUser() u: UserRec) { return this.svc.history(u); }
  @Patch(':id') update(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: UpdateAlertDto) { return this.svc.update(u, id, dto); }
  @Delete(':id') remove(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.remove(u, id); }
}
