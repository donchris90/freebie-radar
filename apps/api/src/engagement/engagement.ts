import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CurrentUser, JwtAuthGuard } from '../auth/auth';
import { canTransition, isPubliclyListed, reportsReachThreshold, transition } from '../core/lifecycle';
import { assertCurrency, MoneyError, parseMajorToMinor } from '../core/money';
import { RISK_LABELS, RiskSignal } from '../core/risk';
import { calculateResale, compareOpportunities } from '../core/resale';
import { REPORT_REASONS, ReportReason, ResaleRec, RiskLevel, UserRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';
import { ListingsService } from '../listings/listings';

// ---------------------------------------------------------------- reports

export class ReportDto {
  @IsIn(REPORT_REASONS) reason!: ReportReason;
  @IsOptional() @IsString() @MaxLength(1000) details?: string;
  @IsOptional() @IsUrl({ protocols: ['https'], require_protocol: true }) evidenceUrl?: string;
}

const REPORT_SIGNAL_CODES = new Set(['MANY_REPORTS', 'SEVERAL_REPORTS']);

@Injectable()
export class ReportsService {
  constructor(@Inject(REPOS) private readonly repos: Repos, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async report(user: UserRec, listingId: string, dto: ReportDto) {
    const l = await this.repos.listings.findById(listingId);
    if (!l || !isPubliclyListed(l.status)) throw new NotFoundException('Listing not found');
    if (l.sellerUserId === user.id) throw new BadRequestException('You cannot report your own listing');

    const created = await this.repos.reports.create({
      id: randomUUID(), listingId, reporterId: user.id, reason: dto.reason, details: dto.details ?? null, evidenceUrl: dto.evidenceUrl ?? null, status: 'OPEN', createdAt: new Date(),
    });
    if (!created) throw new ConflictException('You have already reported this listing for that reason');

    const outcome: Record<string, unknown> = {};
    // Availability evidence: needs several distinct reporters; one report never takes a listing down.
    if (dto.reason === 'UNAVAILABLE' || dto.reason === 'EXPIRED') {
      const n = await this.repos.reports.distinctOpenReporters(listingId, ['UNAVAILABLE', 'EXPIRED']);
      if (reportsReachThreshold(n, this.cfg.reportThreshold) && canTransition(l.status, 'REPORTS_THRESHOLD_REACHED')) {
        const next = transition(l.status, 'REPORTS_THRESHOLD_REACHED');
        await this.repos.listings.update(listingId, { status: next });
        outcome.status = next;
      }
    }
    // Risk evidence: distinct reporters feed the rules-based risk signals; heavy reporting holds the listing for review.
    if (['SUSPICIOUS', 'SCAM', 'PROHIBITED_ITEM'].includes(dto.reason)) {
      const n = await this.repos.reports.distinctOpenReporters(listingId, ['SUSPICIOUS', 'SCAM', 'PROHIBITED_ITEM']);
      const kept = l.riskSignals.filter((s) => !REPORT_SIGNAL_CODES.has(s.code));
      const extra: RiskSignal[] = n >= 5 ? [{ code: 'MANY_REPORTS', points: 60, message: `${n} different users have reported this listing.` }]
        : n >= 3 ? [{ code: 'SEVERAL_REPORTS', points: 25, message: `${n} different users have reported this listing.` }] : [];
      const signals = [...kept, ...extra];
      const points = signals.reduce((s, x) => s + x.points, 0);
      const level: RiskLevel = points >= 60 ? 'UNDER_REVIEW' : points > 0 ? 'EXERCISE_CAUTION' : 'NO_MAJOR_SIGNALS';
      const patch: Record<string, unknown> = { riskSignals: signals, riskLevel: level };
      if (level === 'UNDER_REVIEW' && canTransition(l.status, 'MODERATOR_UNDER_REVIEW')) patch.status = transition(l.status, 'MODERATOR_UNDER_REVIEW');
      await this.repos.listings.update(listingId, patch);
      outcome.riskLevel = RISK_LABELS[level];
    }
    await this.repos.audit.add({ id: randomUUID(), actorId: user.id, action: 'LISTING_REPORTED', entityType: 'Listing', entityId: listingId, metadata: { reason: dto.reason, ...outcome }, createdAt: new Date() });
    return { reported: true, reportId: created.id };
  }
}

// ---------------------------------------------------------------- saved + personalisation

@Injectable()
export class SavedService {
  constructor(@Inject(REPOS) private readonly repos: Repos, private readonly listings: ListingsService) {}

  private async visible(id: string) {
    const l = await this.repos.listings.findById(id);
    if (!l || !isPubliclyListed(l.status)) throw new NotFoundException('Listing not found');
    return l;
  }
  async save(u: UserRec, id: string) {
    const l = await this.visible(id);
    await this.repos.saved.save(u.id, id);
    await this.repos.saved.bumpCategory(u.id, l.categoryKey);
    return { saved: true };
  }
  async unsave(u: UserRec, id: string) { await this.repos.saved.unsave(u.id, id); return { saved: false }; }
  async dismiss(u: UserRec, id: string) { await this.visible(id); await this.repos.saved.dismiss(u.id, id); return { dismissed: true }; }
  async list(u: UserRec) { return { items: await this.listings.viewMany(await this.repos.saved.listIds(u.id), u) }; }
  async resetPersonalisation(u: UserRec) { await this.repos.saved.resetPersonalisation(u.id); return { reset: true }; }
}

// ---------------------------------------------------------------- resale

const PCT = /^\d{1,3}(\.\d{1,2})?$/;
function percentToBps(v: string | undefined, label: string): number {
  if (v === undefined || v === '') return 0;
  if (!PCT.test(v)) throw new BadRequestException(`${label} must be a percentage such as "13" or "12.75"`);
  const bps = Math.round(Number(v) * 100);
  if (bps > 10_000) throw new BadRequestException(`${label} cannot exceed 100%`);
  return bps;
}

export class ResaleDto {
  @IsString() currency!: string;
  @IsString() @MaxLength(20) purchase!: string;
  @IsString() @MaxLength(20) resale!: string;
  @IsOptional() @IsString() @MaxLength(20) transport?: string;
  @IsOptional() @IsString() @MaxLength(20) repair?: string;
  @IsOptional() @IsString() @MaxLength(20) other?: string;
  @IsOptional() @IsString() @MaxLength(8) feePercent?: string;
  @IsOptional() @IsString() @MaxLength(20) feeFixed?: string;
  @IsOptional() @IsString() @Length(1, 80) label?: string;
  @IsOptional() @IsString() listingId?: string;
}

function toInput(dto: ResaleDto) {
  try {
    const currency = assertCurrency(dto.currency);
    const m = (v: string | undefined) => (v === undefined || v === '' ? 0 : parseMajorToMinor(v, currency));
    return {
      currency,
      input: {
        purchaseMinor: m(dto.purchase), resaleMinor: m(dto.resale), transportMinor: m(dto.transport),
        repairMinor: m(dto.repair), otherMinor: m(dto.other), feeBasisPoints: percentToBps(dto.feePercent, 'feePercent'), feeFixedMinor: m(dto.feeFixed),
      },
    };
  } catch (e) {
    if (e instanceof MoneyError) throw new BadRequestException(e.message);
    throw e;
  }
}

@Injectable()
export class ResaleService {
  constructor(@Inject(REPOS) private readonly repos: Repos) {}
  calculate(dto: ResaleDto) {
    const { currency, input } = toInput(dto);
    return calculateResale({ currency, ...input });
  }
  async save(u: UserRec, dto: ResaleDto) {
    if (!dto.label) throw new BadRequestException('A label is required to save a calculation');
    const { currency, input } = toInput(dto);
    if (dto.listingId && !(await this.repos.listings.findById(dto.listingId))) throw new NotFoundException('Listing not found');
    const rec: ResaleRec = { id: randomUUID(), userId: u.id, listingId: dto.listingId ?? null, label: dto.label, currency, input, createdAt: new Date() };
    await this.repos.resale.create(rec);
    return this.view(rec);
  }
  private view(r: ResaleRec) {
    return { id: r.id, label: r.label, listingId: r.listingId, createdAt: r.createdAt, result: calculateResale({ currency: r.currency, ...r.input }) };
  }
  async list(u: UserRec) { return { items: (await this.repos.resale.listByUser(u.id)).map((r) => this.view(r)) }; }
  async compare(u: UserRec) {
    const views = (await this.repos.resale.listByUser(u.id)).map((r) => this.view(r));
    const byCurrency = new Map<string, typeof views>();
    for (const v of views) byCurrency.set(v.result.currency, [...(byCurrency.get(v.result.currency) ?? []), v]);
    // Different currencies are never ranked against each other.
    return { groups: [...byCurrency].map(([currency, items]) => ({ currency, ranked: compareOpportunities(items.map((v) => ({ id: v.id, label: v.label, result: v.result }))) })) };
  }
  async remove(u: UserRec, id: string) {
    const r = await this.repos.resale.findById(id);
    if (!r || r.userId !== u.id) throw new NotFoundException('Calculation not found');
    await this.repos.resale.delete(id);
    return { deleted: true };
  }
}

// ---------------------------------------------------------------- controllers

@Controller()
export class EngagementController {
  constructor(private readonly reports: ReportsService, private readonly saved: SavedService, private readonly resale: ResaleService) {}

  @UseGuards(JwtAuthGuard) @Post('listings/:id/report')
  report(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: ReportDto) { return this.reports.report(u, id, dto); }

  @UseGuards(JwtAuthGuard) @Get('saved')
  savedList(@CurrentUser() u: UserRec) { return this.saved.list(u); }
  @UseGuards(JwtAuthGuard) @Post('saved/:id')
  save(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.saved.save(u, id); }
  @UseGuards(JwtAuthGuard) @Delete('saved/:id')
  unsave(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.saved.unsave(u, id); }
  @UseGuards(JwtAuthGuard) @Post('listings/:id/dismiss')
  dismiss(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.saved.dismiss(u, id); }
  @UseGuards(JwtAuthGuard) @Post('me/personalisation/reset')
  reset(@CurrentUser() u: UserRec) { return this.saved.resetPersonalisation(u); }

  /** Stateless calculator: usable without an account. */
  @Post('resale/calculate')
  calc(@Body() dto: ResaleDto) { return this.resale.calculate(dto); }
  @UseGuards(JwtAuthGuard) @Post('resale')
  saveCalc(@CurrentUser() u: UserRec, @Body() dto: ResaleDto) { return this.resale.save(u, dto); }
  @UseGuards(JwtAuthGuard) @Get('resale')
  listCalcs(@CurrentUser() u: UserRec) { return this.resale.list(u); }
  @UseGuards(JwtAuthGuard) @Get('resale/compare')
  compare(@CurrentUser() u: UserRec) { return this.resale.compare(u); }
  @UseGuards(JwtAuthGuard) @Delete('resale/:id')
  removeCalc(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.resale.remove(u, id); }
}
