import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/auth';
import { APP_CONFIG, AppConfig, PlanConfig } from '../config/config';
import { CountriesService } from '../countries/countries.service';
import { addInterval, amountMatches, entitledTier } from '../core/billing';
import { formatMinor, parseMajorToMinor, MoneyError } from '../core/money';
import { BillingEventRec, PaymentRec, SubscriptionRec, UserRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';
import { JobsService } from '../jobs/jobs.service';
import { BILLING_PROVIDERS, BillingEvent, BillingProvider, BillingProviderError } from './provider';

const HOUR = 3_600_000;
const BENEFITS = ['Up to 25 saved alerts (free accounts get 3)', 'No ads anywhere in the app'];

export class CheckoutDto {
  @IsString() planKey!: string;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
  @IsOptional() @IsIn(['ios', 'android', 'web']) platform?: 'ios' | 'android' | 'web';
}
export class PlansQueryDto {
  @IsOptional() @IsIn(['ios', 'android', 'web']) platform?: 'ios' | 'android' | 'web';
}
export class VerifyPaymentDto {
  @IsString() @Length(8, 80) reference!: string;
}
export class RefundDto {
  @IsString() @Length(8, 80) reference!: string;
  /** Decimal string in major units. Omit for a full refund. */
  @IsOptional() @IsString() @Length(1, 20) amount?: string;
  @IsString() @Length(3, 500) reason!: string;
}
export class SettleRefundDto {
  @IsString() @Length(3, 500) note!: string;
}
export class BillingPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsIn(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']) status?: BillingEventRec['status'];
}

@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing');

  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(BILLING_PROVIDERS) private readonly providers: BillingProvider[],
    private readonly countries: CountriesService,
    jobs: JobsService,
  ) {
    if (cfg.billing.provider) jobs.register({ name: 'billing-reconcile', everyMs: 15 * 60_000, run: () => this.reconcile() });
  }

  private get provider(): BillingProvider | null {
    return this.providers.find((p) => p.key === this.cfg.billing.provider && p.isConfigured()) ?? null;
  }

  private plan(key: string): PlanConfig | undefined {
    return this.cfg.billing.plans.find((p) => p.key === key);
  }

  private iosBlocked(platform?: string) {
    return platform === 'ios' && !this.cfg.billing.allowIos;
  }

  // ---- what the app shows ----
  async plans(user: UserRec, q: PlansQueryDto) {
    const provider = this.provider;
    const blocked = this.iosBlocked(q.platform);
    const available = !!provider && this.cfg.billing.plans.length > 0;
    return {
      available,
      checkoutAllowed: available && !blocked,
      reason: !available ? 'Paid plans are not available yet.' : blocked ? 'Subscriptions cannot be bought in the iPhone app yet.' : null,
      currentTier: user.tier,
      plans: this.cfg.billing.plans.map((p) => ({
        key: p.key, title: p.title, interval: p.interval, tier: p.tier, benefits: BENEFITS,
        prices: Object.entries(p.prices).map(([currency, minor]) => ({ currency, minor, label: formatMinor(minor, currency, user.locale) })),
        defaultCurrency: this.pickCurrency(p, undefined, user.countryCode, null),
      })),
    };
  }

  private pickCurrency(plan: PlanConfig, requested: string | undefined, _country: string, countryCurrency: string | null): string | null {
    const offered = Object.keys(plan.prices);
    if (requested) return offered.includes(requested.toUpperCase()) ? requested.toUpperCase() : null;
    if (countryCurrency && offered.includes(countryCurrency)) return countryCurrency;
    return offered.includes('USD') ? 'USD' : offered[0] ?? null;
  }

  async status(user: UserRec) {
    const sub = await this.repos.billing.getSubscription(user.id);
    const { items } = await this.repos.billing.listPayments({ userId: user.id, offset: 0, limit: 10 });
    const entitled = entitledTier(sub, new Date(), this.cfg.billing.graceDays);
    return {
      tier: user.tier,
      subscription: sub && sub.status !== 'NONE' ? {
        status: sub.status, planKey: sub.planKey, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, active: entitled !== 'FREE',
      } : null,
      payments: items.map((p) => ({ reference: p.reference, status: p.status, amount: formatMinor(p.amountMinor, p.currency, user.locale), createdAt: p.createdAt.toISOString() })),
    };
  }

  // ---- checkout ----
  async checkout(user: UserRec, dto: CheckoutDto) {
    const provider = this.provider;
    if (!provider) throw new BadRequestException('Paid plans are not available yet.');
    if (this.iosBlocked(dto.platform)) throw new ForbiddenException('Subscriptions cannot be bought in the iPhone app yet.');
    if (this.cfg.requireVerifiedEmail && !user.emailVerifiedAt && user.role === 'USER') throw new ForbiddenException('Verify your email before subscribing. Open Profile and enter the code we sent you.');
    const plan = this.plan(dto.planKey);
    if (!plan) throw new NotFoundException('Unknown plan');
    const sub = await this.repos.billing.getSubscription(user.id);
    if (entitledTier(sub, new Date(), this.cfg.billing.graceDays) !== 'FREE' && sub && !sub.cancelAtPeriodEnd && sub.status !== 'CANCELLED') {
      throw new ConflictException('You already have an active subscription.');
    }
    const countryCurrency = (await this.countries.getEnabled(user.countryCode))?.currency ?? null;
    const currency = this.pickCurrency(plan, dto.currency, user.countryCode, countryCurrency);
    if (!currency || !provider.supportsCurrency(currency)) throw new BadRequestException('This plan is not available in that currency.');
    const amountMinor = plan.prices[currency];

    const payment: PaymentRec = {
      id: randomUUID(), userId: user.id, provider: provider.key, reference: `fr_${randomUUID().replace(/-/g, '')}`, providerPaymentRef: null,
      planKey: plan.key, amountMinor, currency, status: 'PENDING', failureReason: null, refundedMinor: 0, createdAt: new Date(), paidAt: null,
    };
    await this.repos.billing.insertPayment(payment);
    try {
      const { checkoutUrl } = await provider.createCheckout({
        email: user.email, amountMinor, currency, reference: payment.reference, planCode: plan.planCodes[currency] ?? null,
        callbackUrl: this.cfg.publicBaseUrl ? `${this.cfg.publicBaseUrl}/billing/return` : null, metadata: { userId: user.id, planKey: plan.key },
      });
      return { checkoutUrl, reference: payment.reference, amount: formatMinor(amountMinor, currency, user.locale), currency };
    } catch (e) {
      await this.repos.billing.transitionPayment(payment.id, ['PENDING'], { status: 'FAILED', failureReason: 'CHECKOUT_NOT_CREATED' });
      this.log.warn(`Checkout failed for ${user.id}: ${(e as Error).message}`);
      throw new BadGatewayException('We could not start the payment. Please try again in a moment.');
    }
  }

  /** The app calls this when the person comes back from the payment page, so access does not wait on the webhook. */
  async confirm(user: UserRec, reference: string) {
    const p = await this.repos.billing.findPayment(reference);
    if (!p || p.userId !== user.id) throw new NotFoundException('Payment not found');
    if (p.status === 'PENDING') {
      const provider = this.providers.find((x) => x.key === p.provider);
      if (provider?.isConfigured()) {
        try {
          const v = await provider.verifyPayment(reference);
          if (v.status === 'SUCCEEDED') await this.applySuccess({ reference, providerPaymentRef: v.providerPaymentRef, amountMinor: v.amountMinor, currency: v.currency, email: v.email });
          else if (v.status === 'FAILED') await this.repos.billing.transitionPayment(p.id, ['PENDING'], { status: 'FAILED', failureReason: 'PROVIDER_DECLINED' });
        } catch (e) {
          if (!(e instanceof BillingProviderError)) throw e;
          throw new BadGatewayException('We could not check the payment just now. Please try again shortly.');
        }
      }
    }
    const fresh = (await this.repos.billing.findPayment(reference))!;
    const user2 = (await this.repos.users.findById(user.id))!;
    return { reference, status: fresh.status, tier: user2.tier };
  }

  async cancel(user: UserRec) {
    const provider = this.provider;
    const sub = await this.repos.billing.getSubscription(user.id);
    if (!provider || !sub || sub.status === 'NONE' || sub.status === 'CANCELLED') throw new BadRequestException('You have no subscription to cancel.');
    if (sub.cancelAtPeriodEnd) return this.status(user);
    const last = (await this.repos.billing.listPayments({ userId: user.id, offset: 0, limit: 20 })).items.find((p) => p.status === 'SUCCEEDED' || p.status === 'PARTIALLY_REFUNDED');
    const planCode = last && sub.planKey ? this.plan(sub.planKey)?.planCodes[last.currency] ?? null : null;
    try {
      await provider.cancelSubscription({ email: user.email, planCode });
    } catch (e) {
      if (!(e instanceof BillingProviderError)) throw e;
      if (e.transient) throw new BadGatewayException('We could not reach the payment provider. Nothing was changed; please try again.');
      throw new ConflictException(e.message);
    }
    await this.repos.billing.saveSubscription({ ...sub, cancelAtPeriodEnd: true });
    await this.audit(user.id, 'SUBSCRIPTION_CANCEL_REQUESTED', user.id, {});
    return this.status(user);
  }

  // ---- webhooks ----
  async handleWebhook(providerKey: string, raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    const provider = this.providers.find((p) => p.key === providerKey && p.isConfigured());
    if (!provider) throw new NotFoundException();
    if (!provider.verifyWebhook(raw, headers)) throw new UnauthorizedException('Bad signature');
    let ev: BillingEvent;
    try { ev = provider.parseEvent(raw); } catch (e) { throw new BadRequestException((e as Error).message); }

    const begun = await this.repos.billing.beginEvent(provider.key, ev.eventKey, ev.kind === 'IGNORED' ? ev.type : ev.kind);
    if (!begun.created) {
      if (begun.event.status === 'PROCESSED' || begun.event.status === 'IGNORED') return { received: true, duplicate: true };
      await this.repos.billing.retryEvent(begun.event.id); // an earlier delivery crashed or failed: try again
    }
    try {
      const outcome = await this.applyEvent(ev);
      await this.repos.billing.finishEvent(begun.event.id, outcome, null);
      return { received: true, duplicate: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.repos.billing.finishEvent(begun.event.id, 'FAILED', msg.slice(0, 500));
      this.log.error(`Billing event ${ev.eventKey} failed: ${msg}`);
      throw new InternalServerErrorException('Event processing failed'); // non-200 makes the provider retry
    }
  }

  private async applyEvent(ev: BillingEvent): Promise<'PROCESSED' | 'IGNORED'> {
    switch (ev.kind) {
      case 'PAYMENT_SUCCEEDED':
        return (await this.applySuccess(ev)) ? 'PROCESSED' : 'IGNORED';
      case 'PAYMENT_FAILED': {
        const p = await this.repos.billing.findPayment(ev.reference);
        if (p) { await this.repos.billing.transitionPayment(p.id, ['PENDING'], { status: 'FAILED', failureReason: 'PROVIDER_DECLINED' }); return 'PROCESSED'; }
        // A failed renewal: the customer keeps access through a short grace period while the provider retries.
        const user = ev.email ? await this.repos.users.findByEmail(ev.email.toLowerCase()) : null;
        const sub = user && (await this.repos.billing.getSubscription(user.id));
        if (!user || !sub || sub.status !== 'ACTIVE') return 'IGNORED';
        await this.repos.billing.saveSubscription({ ...sub, status: 'PAST_DUE' });
        await this.audit(null, 'SUBSCRIPTION_PAST_DUE', user.id, {});
        return 'PROCESSED';
      }
      case 'SUBSCRIPTION_ENDED': {
        const user = ev.email ? await this.repos.users.findByEmail(ev.email.toLowerCase()) : null;
        const sub = user && (await this.repos.billing.getSubscription(user.id));
        if (!user || !sub || sub.status === 'NONE' || sub.status === 'CANCELLED') return 'IGNORED';
        // Access continues until the period already paid for ends.
        await this.repos.billing.saveSubscription({ ...sub, status: 'CANCELLED', cancelAtPeriodEnd: true });
        await this.syncTier(user.id);
        await this.audit(null, 'SUBSCRIPTION_ENDED', user.id, {});
        return 'PROCESSED';
      }
      default:
        return 'IGNORED';
    }
  }

  /**
   * Records a successful charge and grants access. Idempotent: the payment row moves to SUCCEEDED exactly once
   * (atomic transition), and a charge the provider reports again is recognised by its provider id.
   * Returns false when there was nothing to do.
   */
  private async applySuccess(f: { reference: string; providerPaymentRef: string; amountMinor: number; currency: string; email: string | null }): Promise<boolean> {
    const now = new Date();
    const existingByProvider = await this.repos.billing.findPaymentByProviderRef(f.providerPaymentRef);
    const p = await this.repos.billing.findPayment(f.reference);

    if (p) {
      if (existingByProvider && existingByProvider.id !== p.id) return false;
      if (p.status === 'SUCCEEDED' || p.status === 'PARTIALLY_REFUNDED' || p.status === 'REFUNDED' || p.status === 'REFUND_PENDING') return false;
      if (!amountMatches(p.amountMinor, f.amountMinor) || p.currency !== f.currency) {
        await this.repos.billing.transitionPayment(p.id, ['PENDING'], { status: 'FAILED', failureReason: 'AMOUNT_MISMATCH' });
        await this.audit(null, 'PAYMENT_AMOUNT_MISMATCH', p.userId, { reference: p.reference, expected: p.amountMinor, paid: f.amountMinor, currency: f.currency });
        return false;
      }
      const won = await this.repos.billing.transitionPayment(p.id, ['PENDING', 'ABANDONED', 'FAILED'], { status: 'SUCCEEDED', providerPaymentRef: f.providerPaymentRef, paidAt: now, failureReason: null });
      if (!won) return false;
      try {
        await this.grant(p.userId, p.planKey, now);
      } catch (e) {
        // Paid but not granted must never be left looking finished: put the payment back so the retry completes the job.
        await this.repos.billing.transitionPayment(p.id, ['SUCCEEDED'], { status: 'PENDING', paidAt: null }).catch(() => undefined);
        throw e;
      }
      return true;
    }

    // Not one of our checkouts: a renewal the provider charged on its own. Only valid for an existing subscriber.
    if (existingByProvider) return false;
    const user = f.email ? await this.repos.users.findByEmail(f.email.toLowerCase()) : null;
    const sub = user && (await this.repos.billing.getSubscription(user.id));
    const plan = sub?.planKey ? this.plan(sub.planKey) : undefined;
    if (!user || !sub || !plan || sub.status === 'NONE') {
      await this.audit(null, 'PAYMENT_UNMATCHED', null, { reference: f.reference, providerPaymentRef: f.providerPaymentRef });
      return false;
    }
    if (!amountMatches(plan.prices[f.currency], f.amountMinor)) {
      await this.audit(null, 'PAYMENT_AMOUNT_MISMATCH', user.id, { reference: f.reference, paid: f.amountMinor, currency: f.currency });
      return false;
    }
    const inserted = await this.repos.billing.insertPayment({
      id: randomUUID(), userId: user.id, provider: sub.provider ?? 'unknown', reference: f.reference, providerPaymentRef: f.providerPaymentRef, planKey: plan.key,
      amountMinor: f.amountMinor, currency: f.currency, status: 'SUCCEEDED', failureReason: null, refundedMinor: 0, createdAt: now, paidAt: now,
    });
    if (!inserted) return false;
    await this.grant(user.id, plan.key, now);
    return true;
  }

  private async grant(userId: string, planKey: string | null, now: Date) {
    const plan = planKey ? this.plan(planKey) : undefined;
    if (!plan) throw new Error(`Payment refers to unknown plan ${planKey}`);
    const sub = await this.repos.billing.getSubscription(userId);
    const base = sub?.currentPeriodEnd && sub.currentPeriodEnd > now && sub.status !== 'CANCELLED' ? sub.currentPeriodEnd : now;
    const rec: SubscriptionRec = {
      userId, tier: plan.tier, status: 'ACTIVE', planKey: plan.key, provider: this.cfg.billing.provider, providerRef: sub?.providerRef ?? null,
      currentPeriodEnd: addInterval(base, plan.interval), cancelAtPeriodEnd: false,
    };
    await this.repos.billing.saveSubscription(rec);
    await this.syncTier(userId);
    await this.audit(null, 'SUBSCRIPTION_PAID', userId, { plan: plan.key, until: rec.currentPeriodEnd!.toISOString() });
  }

  /** Makes users.tier agree with the subscription. Accounts on a manually granted BUSINESS tier are left alone. */
  async syncTier(userId: string, now = new Date()) {
    const user = await this.repos.users.findById(userId);
    if (!user || user.tier === 'BUSINESS') return;
    const tier = entitledTier(await this.repos.billing.getSubscription(userId), now, this.cfg.billing.graceDays);
    if (tier !== user.tier) {
      await this.repos.users.update(userId, { tier });
      await this.audit(null, tier === 'FREE' ? 'TIER_DOWNGRADED' : 'TIER_UPGRADED', userId, { tier });
    }
  }

  // ---- scheduled upkeep ----
  /** Catches what lost webhooks leave behind: stale checkouts are checked with the provider, lapsed access is removed. */
  async reconcile(now = new Date()) {
    let confirmed = 0;
    let abandoned = 0;
    const provider = this.provider;
    for (const p of await this.repos.billing.stalePending(new Date(now.getTime() - HOUR))) {
      if (provider && p.provider === provider.key) {
        try {
          const v = await provider.verifyPayment(p.reference);
          if (v.status === 'SUCCEEDED') { if (await this.applySuccess({ reference: p.reference, providerPaymentRef: v.providerPaymentRef, amountMinor: v.amountMinor, currency: v.currency, email: v.email })) confirmed++; continue; }
        } catch { continue; } // provider unreachable: leave it for the next run
      }
      if (now.getTime() - p.createdAt.getTime() > 24 * HOUR && (await this.repos.billing.transitionPayment(p.id, ['PENDING'], { status: 'ABANDONED' }))) abandoned++;
    }
    let reviewed = 0;
    for (const s of await this.repos.billing.listSubscriptions(['ACTIVE', 'PAST_DUE', 'CANCELLED'])) { await this.syncTier(s.userId, now); reviewed++; }
    return { confirmed, abandoned, reviewed };
  }

  // ---- admin ----
  async payments(q: BillingPageDto) { return this.repos.billing.listPayments({ offset: q.offset ?? 0, limit: q.limit ?? 25 }); }
  async events(q: BillingPageDto) { return { items: await this.repos.billing.listEvents({ status: q.status, limit: q.limit ?? 50 }) }; }

  async refund(admin: UserRec, dto: RefundDto) {
    const p = await this.repos.billing.findPayment(dto.reference);
    if (!p) throw new NotFoundException('Payment not found');
    if ((p.status !== 'SUCCEEDED' && p.status !== 'PARTIALLY_REFUNDED') || !p.providerPaymentRef) throw new BadRequestException('Only a successful payment can be refunded.');
    const provider = this.providers.find((x) => x.key === p.provider && x.isConfigured());
    if (!provider) throw new BadRequestException('The provider for this payment is not configured.');
    const remaining = p.amountMinor - p.refundedMinor;
    let amountMinor = remaining;
    if (dto.amount) {
      try { amountMinor = parseMajorToMinor(dto.amount, p.currency); } catch (e) { if (e instanceof MoneyError) throw new BadRequestException(e.message); throw e; }
      if (amountMinor <= 0 || amountMinor > remaining) throw new BadRequestException('The refund must be more than zero and no more than what is left.');
    }
    let result: { refundRef: string; done: boolean };
    try {
      result = await provider.refund({ providerPaymentRef: p.providerPaymentRef, amountMinor: dto.amount ? amountMinor : undefined, currency: p.currency });
    } catch (e) {
      if (e instanceof BillingProviderError) throw new BadGatewayException(`The provider did not accept the refund: ${e.message}`);
      throw e;
    }
    const full = amountMinor >= remaining;
    const status: PaymentRec['status'] = !result.done ? 'REFUND_PENDING' : full ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    await this.repos.billing.transitionPayment(p.id, ['SUCCEEDED', 'PARTIALLY_REFUNDED'], { status, refundedMinor: result.done ? p.refundedMinor + amountMinor : p.refundedMinor });
    if (full) await this.endAccessNow(p.userId, provider);
    await this.audit(admin.id, 'PAYMENT_REFUND', p.userId, { reference: p.reference, amountMinor, currency: p.currency, reason: dto.reason, done: result.done, refundRef: result.refundRef });
    return { reference: p.reference, status, refundRef: result.refundRef };
  }

  /** The provider does not tell us when a pending refund completes, so a person confirms it from the provider dashboard. */
  async settleRefund(admin: UserRec, reference: string, dto: SettleRefundDto) {
    const p = await this.repos.billing.findPayment(reference);
    if (!p || p.status !== 'REFUND_PENDING') throw new BadRequestException('This payment has no pending refund.');
    await this.repos.billing.transitionPayment(p.id, ['REFUND_PENDING'], { status: 'REFUNDED', refundedMinor: p.amountMinor });
    await this.audit(admin.id, 'PAYMENT_REFUND_SETTLED', p.userId, { reference, note: dto.note });
    return { reference, status: 'REFUNDED' };
  }

  /** A full refund removes premium straight away and stops the provider billing again. */
  private async endAccessNow(userId: string, provider: BillingProvider) {
    const sub = await this.repos.billing.getSubscription(userId);
    const user = await this.repos.users.findById(userId);
    if (!sub || !user) return;
    try { await provider.cancelSubscription({ email: user.email, planCode: null }); } catch { /* nothing to stop, or the provider is down; access ends here either way */ }
    await this.repos.billing.saveSubscription({ ...sub, status: 'CANCELLED', cancelAtPeriodEnd: true, currentPeriodEnd: new Date() });
    await this.syncTier(userId);
  }

  private async audit(actorId: string | null, action: string, entityId: string | null, metadata: Record<string, unknown>) {
    await this.repos.audit.add({ id: randomUUID(), actorId, action, entityType: 'Billing', entityId: entityId ?? 'none', metadata, createdAt: new Date() });
  }
}

const CHECKOUT_LIMIT = Number(process.env.BILLING_THROTTLE_LIMIT ?? 10);

@Controller()
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @UseGuards(JwtAuthGuard) @Get('billing/plans')
  plans(@CurrentUser() u: UserRec, @Query() q: PlansQueryDto) { return this.svc.plans(u, q); }

  @UseGuards(JwtAuthGuard) @Get('billing/status')
  status(@CurrentUser() u: UserRec) { return this.svc.status(u); }

  @UseGuards(JwtAuthGuard) @Throttle({ default: { limit: CHECKOUT_LIMIT, ttl: 60_000 } }) @Post('billing/checkout')
  checkout(@CurrentUser() u: UserRec, @Body() dto: CheckoutDto) { return this.svc.checkout(u, dto); }

  @UseGuards(JwtAuthGuard) @Throttle({ default: { limit: CHECKOUT_LIMIT * 3, ttl: 60_000 } }) @Post('billing/verify')
  verify(@CurrentUser() u: UserRec, @Body() dto: VerifyPaymentDto) { return this.svc.confirm(u, dto.reference); }

  @UseGuards(JwtAuthGuard) @Post('billing/cancel')
  cancel(@CurrentUser() u: UserRec) { return this.svc.cancel(u); }

  /** Public, but authenticated by the provider's signature/secret. The body arrives raw (see configureApp). */
  @SkipThrottle() @HttpCode(200) @Post('billing/webhook/:provider')
  webhook(@Param('provider') provider: string, @Req() req: { body: unknown; headers: Record<string, string | string[] | undefined> }) {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException('Expected a raw body');
    return this.svc.handleWebhook(provider, req.body, req.headers);
  }

  /** Where the payment page sends people back to. It only tells them to return to the app. */
  @SkipThrottle() @Get('billing/return')
  back(@Res() res: { type(t: string): { send(b: string): void } }) {
    res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Freebie Radar</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem"><h1>Thank you</h1><p>You can close this page and go back to Freebie Radar. Your upgrade appears in the app within a moment.</p></body>');
  }
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingAdminController {
  constructor(private readonly svc: BillingService) {}

  @Roles('ADMIN') @Get('admin/billing/payments')
  payments(@Query() q: BillingPageDto) { return this.svc.payments(q); }
  @Roles('ADMIN') @Get('admin/billing/events')
  events(@Query() q: BillingPageDto) { return this.svc.events(q); }
  @Roles('ADMIN') @Post('admin/billing/refund')
  refund(@CurrentUser() u: UserRec, @Body() dto: RefundDto) { return this.svc.refund(u, dto); }
  @Roles('ADMIN') @Post('admin/billing/refunds/:reference/settle')
  settle(@CurrentUser() u: UserRec, @Param('reference') ref: string, @Body() dto: SettleRefundDto) { return this.svc.settleRefund(u, ref, dto); }
}
