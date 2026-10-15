import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/auth';
import { canTransition, LifecycleEvent, transition } from '../core/lifecycle';
import { ModerationType, UserRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';
import { AlertsService } from '../engagement/alerts';
import { ListingsService } from '../listings/listings';
import { JobsService } from '../jobs/jobs.service';

export class ModerateDto {
  @IsIn(['REMOVE_LISTING', 'MARK_UNDER_REVIEW', 'RESTORE_LISTING', 'DISMISS_REPORT']) action!: ModerationType;
  @IsString() @Length(3, 500) reason!: string;
}
export class AppealDto {
  @IsString() moderationId!: string;
  @IsString() @Length(10, 1000) message!: string;
}
export class ResolveAppealDto {
  @IsIn(['UPHELD', 'REJECTED']) decision!: 'UPHELD' | 'REJECTED';
  @IsString() @Length(3, 500) note!: string;
}
export class UserStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED']) status!: 'ACTIVE' | 'SUSPENDED';
  @IsString() @Length(3, 500) reason!: string;
}
export class UserLookupDto {
  @IsString() @Length(3, 254) email!: string;
}
export class PageDto {
  @IsOptional() @IsIn(['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED']) status?: 'OPEN' | 'IN_REVIEW' | 'ACTIONED' | 'DISMISSED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

const EVENT_FOR: Record<Exclude<ModerationType, 'DISMISS_REPORT'>, LifecycleEvent> = {
  REMOVE_LISTING: 'MODERATOR_REMOVE',
  MARK_UNDER_REVIEW: 'MODERATOR_UNDER_REVIEW',
  RESTORE_LISTING: 'MODERATOR_RESTORE',
};

@Injectable()
export class ModerationService {
  constructor(@Inject(REPOS) private readonly repos: Repos, private readonly listings: ListingsService, private readonly alerts: AlertsService, private readonly jobs: JobsService) {}

  async queue(q: PageDto) {
    const { items, total } = await this.repos.reports.listByStatus(q.status ?? 'OPEN', q.offset ?? 0, q.limit ?? 25);
    const rows = await Promise.all(items.map(async (r) => {
      const l = await this.repos.listings.findById(r.listingId);
      return { report: r, listing: l && { id: l.id, title: l.title, status: l.status, riskLevel: l.riskLevel, riskSignals: l.riskSignals.map((s) => s.message), sellerUserId: l.sellerUserId } };
    }));
    return { items: rows, total };
  }

  async moderate(mod: UserRec, listingId: string, dto: ModerateDto, reportId?: string) {
    const l = await this.repos.listings.findById(listingId);
    if (!l) throw new NotFoundException('Listing not found');
    let from = l.status;
    if (dto.action !== 'DISMISS_REPORT') {
      const ev = EVENT_FOR[dto.action];
      if (!canTransition(l.status, ev)) throw new ConflictException(`${dto.action} is not possible while the listing is ${l.status}`);
      const next = transition(l.status, ev);
      await this.repos.listings.update(listingId, { status: next, ...(next === 'ACTIVE' ? { lastConfirmedAt: new Date() } : {}) });
    }
    const m = await this.repos.moderation.add({ id: randomUUID(), listingId, moderatorId: mod.id, type: dto.action, reason: dto.reason, createdAt: new Date() });
    if (reportId) await this.repos.reports.setStatus(reportId, dto.action === 'DISMISS_REPORT' ? 'DISMISSED' : 'ACTIONED');
    else await this.repos.reports.setStatusForListing(listingId, dto.action === 'DISMISS_REPORT' ? 'DISMISSED' : 'ACTIONED');
    await this.repos.audit.add({ id: randomUUID(), actorId: mod.id, action: `MODERATION_${dto.action}`, entityType: 'Listing', entityId: listingId, metadata: { reason: dto.reason, from, moderationId: m.id }, createdAt: new Date() });
    return { moderationId: m.id, status: (await this.repos.listings.findById(listingId))!.status };
  }

  async resolveReport(mod: UserRec, reportId: string, dto: ModerateDto) {
    const r = await this.repos.reports.findById(reportId);
    if (!r) throw new NotFoundException('Report not found');
    return this.moderate(mod, r.listingId, dto, reportId);
  }

  // Appeals: owners of moderated listings can contest a decision.
  async appeal(user: UserRec, dto: AppealDto) {
    const m = await this.repos.moderation.findById(dto.moderationId);
    const l = m && (await this.repos.listings.findById(m.listingId));
    if (!m || !l || l.sellerUserId !== user.id) throw new NotFoundException('Moderation decision not found');
    if (m.type === 'DISMISS_REPORT' || m.type === 'RESTORE_LISTING') throw new BadRequestException('Only removals and reviews can be appealed');
    const pending = await this.repos.moderation.listAppeals('PENDING');
    if (pending.some((a) => a.moderationId === m.id)) throw new ConflictException('An appeal for this decision is already pending');
    const a = await this.repos.moderation.addAppeal({ id: randomUUID(), moderationId: m.id, userId: user.id, message: dto.message, status: 'PENDING', createdAt: new Date() });
    await this.repos.audit.add({ id: randomUUID(), actorId: user.id, action: 'APPEAL_SUBMITTED', entityType: 'Listing', entityId: l.id, metadata: { appealId: a.id }, createdAt: new Date() });
    return a;
  }

  appeals() { return this.repos.moderation.listAppeals('PENDING'); }

  async resolveAppeal(mod: UserRec, id: string, dto: ResolveAppealDto) {
    const a = await this.repos.moderation.findAppeal(id);
    if (!a || a.status !== 'PENDING') throw new NotFoundException('Pending appeal not found');
    if (a.userId === mod.id) throw new ForbiddenException('You cannot resolve your own appeal');
    const m = (await this.repos.moderation.findById(a.moderationId))!;
    await this.repos.moderation.setAppealStatus(id, dto.decision);
    if (dto.decision === 'UPHELD') {
      const l = (await this.repos.listings.findById(m.listingId))!;
      if (canTransition(l.status, 'MODERATOR_RESTORE')) await this.repos.listings.update(l.id, { status: transition(l.status, 'MODERATOR_RESTORE'), lastConfirmedAt: new Date() });
    }
    await this.repos.audit.add({ id: randomUUID(), actorId: mod.id, action: `APPEAL_${dto.decision}`, entityType: 'Listing', entityId: m.listingId, metadata: { appealId: id, note: dto.note }, createdAt: new Date() });
    return { id, status: dto.decision };
  }

  private adminUser(u: UserRec) {
    return { id: u.id, email: u.email, displayName: u.displayName, role: u.role, status: u.status, emailVerified: !!u.emailVerifiedAt, countryCode: u.countryCode, createdAt: u.createdAt.toISOString() };
  }

  async findUser(q: UserLookupDto) {
    const u = await this.repos.users.findByEmail(q.email.trim().toLowerCase());
    if (!u) throw new NotFoundException('No account with that email');
    return this.adminUser(u);
  }

  /** Suspending signs the person out everywhere and holds their public listings for review. Restoring does not republish them. */
  async setUserStatus(admin: UserRec, id: string, dto: UserStatusDto) {
    const u = await this.repos.users.findById(id);
    if (!u || u.status === 'DELETED') throw new NotFoundException('Account not found');
    if (u.id === admin.id) throw new ForbiddenException('You cannot change your own account status.');
    if (u.role === 'ADMIN') throw new ForbiddenException('Admin accounts cannot be suspended here.');
    if (u.status === dto.status) return this.adminUser(u);
    let held = 0;
    if (dto.status === 'SUSPENDED') {
      await this.repos.users.update(u.id, { status: 'SUSPENDED', tokenVersion: u.tokenVersion + 1 });
      await this.repos.tokens.revokeAllForUser(u.id, new Date());
      const own = await this.repos.listings.search({ sellerUserId: u.id, publicOnly: false, sort: 'newest', offset: 0, limit: 1000 });
      for (const l of own.items) {
        if (canTransition(l.status, 'MODERATOR_UNDER_REVIEW')) { await this.repos.listings.update(l.id, { status: transition(l.status, 'MODERATOR_UNDER_REVIEW') }); held++; }
      }
    } else {
      await this.repos.users.update(u.id, { status: 'ACTIVE' });
    }
    await this.repos.audit.add({ id: randomUUID(), actorId: admin.id, action: dto.status === 'SUSPENDED' ? 'USER_SUSPENDED' : 'USER_RESTORED', entityType: 'User', entityId: u.id, metadata: { reason: dto.reason, listingsHeld: held }, createdAt: new Date() });
    return this.adminUser((await this.repos.users.findById(u.id))!);
  }

  async stats() { return this.repos.stats.stats(); }
  async audit(q: PageDto) { return this.repos.audit.list(q.offset ?? 0, q.limit ?? 50); }
  jobStatus() { return this.jobs.status(); }
  async queueJob(name: string) {
    try { return await this.jobs.runNow(name); } catch (e) { throw new NotFoundException((e as Error).message); }
  }
  runExpiry() { return this.listings.runExpiry(); }
  dispatchAlerts() { return this.alerts.dispatchPending(); }
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(private readonly svc: ModerationService) {}

  @Roles('MODERATOR', 'ADMIN') @Get('admin/reports')
  queue(@Query() q: PageDto) { return this.svc.queue(q); }
  @Roles('MODERATOR', 'ADMIN') @Post('admin/reports/:id/resolve')
  resolve(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: ModerateDto) { return this.svc.resolveReport(u, id, dto); }
  @Roles('MODERATOR', 'ADMIN') @Post('admin/listings/:id/moderate')
  moderate(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: ModerateDto) { return this.svc.moderate(u, id, dto); }
  @Roles('MODERATOR', 'ADMIN') @Get('admin/appeals')
  appeals() { return this.svc.appeals(); }
  @Roles('MODERATOR', 'ADMIN') @Post('admin/appeals/:id/resolve')
  resolveAppeal(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: ResolveAppealDto) { return this.svc.resolveAppeal(u, id, dto); }

  @Roles('ADMIN') @Get('admin/users')
  user(@Query() q: UserLookupDto) { return this.svc.findUser(q); }
  @Roles('ADMIN') @Post('admin/users/:id/status')
  userStatus(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: UserStatusDto) { return this.svc.setUserStatus(u, id, dto); }

  @Roles('ADMIN') @Get('admin/stats')
  stats() { return this.svc.stats(); }
  @Roles('ADMIN') @Get('admin/audit')
  audit(@Query() q: PageDto) { return this.svc.audit(q); }
  @Roles('ADMIN') @Get('admin/jobs/status')
  jobStatus() { return this.svc.jobStatus(); }
  @Roles('ADMIN') @Post('admin/jobs/queue/:name')
  queueJob(@Param('name') name: string) { return this.svc.queueJob(name); }
  @Roles('ADMIN') @Post('admin/jobs/expire')
  expire() { return this.svc.runExpiry(); }
  @Roles('ADMIN') @Post('admin/jobs/dispatch-alerts')
  dispatch() { return this.svc.dispatchAlerts(); }
}

@Controller()
export class AppealController {
  constructor(private readonly svc: ModerationService) {}
  @UseGuards(JwtAuthGuard) @Post('appeals')
  appeal(@CurrentUser() u: UserRec, @Body() dto: AppealDto) { return this.svc.appeal(u, dto); }
}
