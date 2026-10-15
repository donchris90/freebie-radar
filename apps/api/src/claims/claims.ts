import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  UseGuards,
  ConflictException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { CurrentUser, JwtAuthGuard } from '../auth/auth';
import { APP_CONFIG, AppConfig } from '../config/config';
import { canReportNoShow, isActiveClaim, reliability } from '../core/claims';
import { canTransition, transition } from '../core/lifecycle';
import { ClaimRec, ListingRec, UserRec } from '../domain/models';
import { PUSH_SENDER, PushSender, REPOS, Repos } from '../domain/ports';
import { JobsService } from '../jobs/jobs.service';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const CLAIM_LIMIT = Number(process.env.CLAIM_THROTTLE_LIMIT ?? 20);

/** A listing can be reserved only when a person is giving it away free and it is open. */
export function isClaimable(l: ListingRec): boolean {
  return l.sellerUserId !== null && l.sourceKey !== 'spotted' && l.status === 'ACTIVE' && l.isFree && l.priceMinor === 0;
}

@Injectable()
export class ClaimsService implements OnModuleInit {
  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register({ name: 'expire-claims', everyMs: 5 * MINUTE, run: () => this.expireDue() });
  }

  private requireVerified(user: UserRec) {
    if (this.cfg.requireVerifiedEmail && !user.emailVerifiedAt && user.role === 'USER') {
      throw new ForbiddenException('Verify your email before reserving items. Open Profile and enter the code we sent you.');
    }
  }

  /** Push says only that something changed; details stay in the app. Best effort. */
  private async notify(userId: string, title: string, body: string, claimId: string) {
    try {
      const to = await this.repos.users.findById(userId);
      if (!to || to.status !== 'ACTIVE' || !to.prefs.pushEnabled || !to.prefs.pushToken) return;
      await this.push.send({ token: to.prefs.pushToken, title, body: body.slice(0, 100), data: { claimId } });
    } catch { /* a failed push must never fail a reservation */ }
  }

  private async audit(actorId: string | null, action: string, claimId: string, metadata: Record<string, unknown> = {}) {
    await this.repos.audit.add({ id: randomUUID(), actorId, action, entityType: 'Claim', entityId: claimId, metadata, createdAt: new Date() });
  }

  // ---- views ----
  private async view(c: ClaimRec, viewer: UserRec) {
    const asGiver = c.giverId === viewer.id;
    const [listing, other] = await Promise.all([this.repos.listings.findById(c.listingId), this.repos.users.findById(asGiver ? c.claimerId : c.giverId)]);
    const now = new Date();
    const active = isActiveClaim(c.status);
    return {
      id: c.id,
      role: asGiver ? ('GIVER' as const) : ('CLAIMER' as const),
      status: c.status,
      listing: listing ? { id: listing.id, title: listing.title, image: listing.imageUrls[0] ?? null, status: listing.status } : { id: c.listingId, title: 'Removed listing', image: null, status: 'REMOVED' },
      other: { displayName: other && other.status !== 'DELETED' ? other.displayName : 'Former member' },
      /** Shown to the giver about the person who wants the item; never the reverse and never before a few outcomes exist. */
      claimerReliability: asGiver ? reliability(await this.repos.claims.tally(c.claimerId)) : undefined,
      createdAt: c.createdAt.toISOString(),
      confirmedAt: c.confirmedAt?.toISOString() ?? null,
      expiresAt: active ? c.holdExpiresAt.toISOString() : null,
      actions: {
        confirm: asGiver && c.status === 'HELD',
        collected: asGiver && active,
        noShow: asGiver && c.status === 'CONFIRMED' && canReportNoShow(c.confirmedAt, now),
        cancel: active,
      },
    };
  }

  private async load(user: UserRec, id: string): Promise<ClaimRec> {
    const c = await this.repos.claims.findById(id);
    if (!c || (c.claimerId !== user.id && c.giverId !== user.id)) throw new NotFoundException('Reservation not found');
    return c;
  }

  // ---- actions ----
  async create(user: UserRec, listingId: string) {
    this.requireVerified(user);
    const hidden = new NotFoundException('Listing not found');
    const listing = await this.repos.listings.findById(listingId);
    if (!listing || listing.status !== 'ACTIVE') throw hidden;
    if (!listing.sellerUserId || listing.sourceKey === 'spotted') throw new BadRequestException('This item cannot be reserved. Messages and reservations are for items a member is giving away.');
    if (!isClaimable(listing)) throw new BadRequestException('Only free items can be reserved.');
    if (listing.sellerUserId === user.id) throw new BadRequestException('This is your own listing.');
    const giver = await this.repos.users.findById(listing.sellerUserId);
    if (!giver || giver.status !== 'ACTIVE') throw hidden;
    // A block in either direction looks like the listing does not exist; the blocked person is not told.
    if ((await this.repos.blocks.blockedIds(user.id)).includes(giver.id) || (await this.repos.blocks.blockedIds(giver.id)).includes(user.id)) throw hidden;
    if ((await this.repos.claims.countActiveByClaimer(user.id)) >= this.cfg.claims.maxActivePerUser) {
      throw new ConflictException(`You already have ${this.cfg.claims.maxActivePerUser} active reservations. Finish or cancel one first.`);
    }
    const now = new Date();
    const rec: ClaimRec = {
      id: randomUUID(), listingId, claimerId: user.id, giverId: giver.id, status: 'HELD',
      holdExpiresAt: new Date(now.getTime() + this.cfg.claims.holdMinutes * MINUTE), confirmedAt: null, resolvedAt: null, endedBy: null, createdAt: now,
    };
    const saved = await this.repos.claims.insertActive(rec);
    if (!saved) throw new ConflictException('Someone has already reserved this item. Check back soon: reservations that are not confirmed are released automatically.');
    await this.audit(user.id, 'CLAIM_CREATED', saved.id, { listingId });
    await this.notify(giver.id, 'Someone wants your item', `About: ${listing.title}`, saved.id);
    return this.view(saved, user);
  }

  async confirm(user: UserRec, id: string) {
    const c = await this.load(user, id);
    if (c.giverId !== user.id) throw new ForbiddenException('Only the person giving the item can confirm.');
    const now = new Date();
    const next = await this.repos.claims.transition(id, ['HELD'], { status: 'CONFIRMED', confirmedAt: now, holdExpiresAt: new Date(now.getTime() + this.cfg.claims.pickupHours * HOUR) });
    if (!next) throw new ConflictException('This reservation can no longer be confirmed.');
    await this.audit(user.id, 'CLAIM_CONFIRMED', id);
    await this.notify(c.claimerId, 'Your reservation is confirmed', 'Open the app to arrange pickup.', id);
    return this.view(next, user);
  }

  async collected(user: UserRec, id: string) {
    const c = await this.load(user, id);
    if (c.giverId !== user.id) throw new ForbiddenException('Only the person giving the item can mark it collected.');
    const now = new Date();
    const next = await this.repos.claims.transition(id, ['HELD', 'CONFIRMED'], { status: 'COLLECTED', resolvedAt: now, endedBy: 'GIVER' });
    if (!next) throw new ConflictException('This reservation is already finished.');
    // The item is gone: close the listing so nobody else reserves or messages about it.
    const listing = await this.repos.listings.findById(c.listingId);
    if (listing && canTransition(listing.status, 'SELLER_MARKED_UNAVAILABLE')) {
      await this.repos.listings.update(listing.id, { status: transition(listing.status, 'SELLER_MARKED_UNAVAILABLE') });
    }
    await this.audit(user.id, 'CLAIM_COLLECTED', id, { listingId: c.listingId });
    return this.view(next, user);
  }

  async noShow(user: UserRec, id: string) {
    const c = await this.load(user, id);
    if (c.giverId !== user.id) throw new ForbiddenException('Only the person giving the item can report a no-show.');
    const now = new Date();
    if (c.status !== 'CONFIRMED') throw new ConflictException('A no-show can only be reported for a confirmed pickup.');
    if (!canReportNoShow(c.confirmedAt, now)) throw new ConflictException('Please give the person a little longer before reporting a no-show.');
    const next = await this.repos.claims.transition(id, ['CONFIRMED'], { status: 'NO_SHOW', resolvedAt: now, endedBy: 'GIVER' });
    if (!next) throw new ConflictException('This reservation is already finished.');
    await this.audit(user.id, 'CLAIM_NO_SHOW', id, { listingId: c.listingId });
    return this.view(next, user);
  }

  async cancel(user: UserRec, id: string) {
    const c = await this.load(user, id);
    const next = await this.repos.claims.transition(id, ['HELD', 'CONFIRMED'], { status: 'CANCELLED', resolvedAt: new Date(), endedBy: c.giverId === user.id ? 'GIVER' : 'CLAIMER' });
    if (!next) throw new ConflictException('This reservation is already finished.');
    await this.audit(user.id, 'CLAIM_CANCELLED', id, { by: next.endedBy, afterConfirm: c.confirmedAt !== null });
    await this.notify(c.giverId === user.id ? c.claimerId : c.giverId, 'A reservation was cancelled', 'The item is available again.', id);
    return this.view(next, user);
  }

  async mine(user: UserRec) {
    const [asClaimer, asGiver] = await Promise.all([this.repos.claims.listForClaimer(user.id, 50), this.repos.claims.listForGiver(user.id, 50)]);
    return {
      asClaimer: await Promise.all(asClaimer.map((c) => this.view(c, user))),
      asGiver: await Promise.all(asGiver.map((c) => this.view(c, user))),
    };
  }

  /** What this viewer needs to know about the reservation on one listing. */
  async forListing(user: UserRec | undefined, listingId: string) {
    const listing = await this.repos.listings.findById(listingId);
    if (!listing || (listing.status !== 'ACTIVE' && listing.status !== 'POSSIBLY_EXPIRED')) throw new NotFoundException('Listing not found');
    const active = await this.repos.claims.activeForListing(listingId);
    const mine = active && user && active.claimerId === user.id ? await this.view(active, user) : null;
    const forGiver = active && user && active.giverId === user.id ? await this.view(active, user) : null;
    return { claimable: isClaimable(listing) && !!user && listing.sellerUserId !== user.id, reserved: !!active, mine, forGiver };
  }

  /** Background job: lapse unconfirmed holds and missed pickups, and release reservations on items that are gone. Idempotent. */
  async expireDue(now = new Date()) {
    let expired = 0;
    let cancelled = 0;
    for (const c of await this.repos.claims.listActive(1000)) {
      const listing = await this.repos.listings.findById(c.listingId);
      const gone = !listing || (listing.status !== 'ACTIVE' && listing.status !== 'POSSIBLY_EXPIRED');
      if (gone) {
        if (await this.repos.claims.transition(c.id, ['HELD', 'CONFIRMED'], { status: 'CANCELLED', resolvedAt: now, endedBy: 'SYSTEM' })) cancelled++;
      } else if (c.holdExpiresAt.getTime() <= now.getTime()) {
        // A lapsed hold is nobody's fault: it never counts for or against either person.
        if (await this.repos.claims.transition(c.id, ['HELD', 'CONFIRMED'], { status: 'EXPIRED', resolvedAt: now, endedBy: 'SYSTEM' })) expired++;
      }
    }
    return { expired, cancelled };
  }
}

@Controller()
@UseGuards(JwtAuthGuard)
export class ClaimsController {
  constructor(private readonly svc: ClaimsService) {}

  @Throttle({ default: { limit: CLAIM_LIMIT, ttl: 60_000 } })
  @Post('listings/:id/claims')
  create(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.create(u, id); }

  @Get('listings/:id/claim')
  forListing(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.forListing(u, id); }

  @Get('claims/mine')
  mine(@CurrentUser() u: UserRec) { return this.svc.mine(u); }

  @Post('claims/:id/confirm')
  confirm(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.confirm(u, id); }

  @Post('claims/:id/collected')
  collected(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.collected(u, id); }

  @Post('claims/:id/no-show')
  noShow(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.noShow(u, id); }

  @Post('claims/:id/cancel')
  cancel(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.cancel(u, id); }
}
