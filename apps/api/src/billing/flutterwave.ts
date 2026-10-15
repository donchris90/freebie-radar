import { timingSafeEqual } from 'crypto';
import { currencyExponent } from '../core/money';
import { BillingEvent, BillingProvider, BillingProviderError, CheckoutInput, VerifiedPayment } from './provider';

/**
 * Flutterwave (API v3) adapter. Endpoint and webhook shapes follow Flutterwave's public documentation
 * (developer.flutterwave.com). It has been exercised only against a local stand-in server. Run the whole flow in
 * Flutterwave's test mode before taking real money, and check the endpoints marked UNVERIFIED in docs/BILLING.md.
 *
 * Differences from other providers that shape this code:
 *  - Webhooks are authenticated by a `verif-hash` header that must equal the secret hash you set in the dashboard
 *    (a shared secret, not an HMAC of the body). Treat it like a password and keep the endpoint on HTTPS.
 *  - Events: `charge.completed` (successful or failed, for first charges and renewals) and `subscription.cancelled`.
 *  - Amounts are decimal major units; we convert to and from minor units.
 *  - Subscriptions are found by customer email and plan, not by a subscription code in the webhook.
 *  - Duplicate deliveries happen, so an event is identified by its name plus the object's own id.
 */

export interface FlutterwaveOptions {
  secretKey: string | null;
  secretHash: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, any>;

const toMinor = (major: unknown, currency: string): number => Math.round(Number(major) * 10 ** currencyExponent(currency));
const toMajor = (minor: number, currency: string): number => minor / 10 ** currencyExponent(currency);

export class FlutterwaveProvider implements BillingProvider {
  readonly key = 'flutterwave';
  readonly name = 'Flutterwave';
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: FlutterwaveOptions) {
    this.base = (o.baseUrl ?? 'https://api.flutterwave.com').replace(/\/$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  isConfigured() { return !!this.o.secretKey && !!this.o.secretHash; }
  setupInstructions() { return 'Set FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_SECRET_HASH (the "secret hash" from Settings → Webhooks on your Flutterwave dashboard), and create a payment plan per currency. Use test keys until the whole flow has been tested.'; }
  supportsCurrency() { return true; } // which currencies work is decided by the merchant account and the prices we configure

  private async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: Json): Promise<Json> {
    if (!this.o.secretKey) throw new BillingProviderError('Flutterwave is not configured', false);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method, signal: ctl.signal, redirect: 'error',
        headers: { authorization: `Bearer ${this.o.secretKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new BillingProviderError(ctl.signal.aborted ? 'Flutterwave timed out' : 'Could not reach Flutterwave');
    } finally {
      clearTimeout(timer);
    }
    let json: Json = {};
    try { json = (await res.json()) as Json; } catch { /* leave empty */ }
    if (res.status >= 500 || res.status === 429) throw new BillingProviderError(`Flutterwave answered ${res.status}`);
    if (!res.ok || json.status === 'error') throw new BillingProviderError(typeof json.message === 'string' ? json.message : `Flutterwave answered ${res.status}`, false);
    return json;
  }

  async createCheckout(i: CheckoutInput) {
    // With a payment plan the customer pays by card and Flutterwave bills them again each interval.
    const json = await this.call('POST', '/v3/payments', {
      tx_ref: i.reference, amount: toMajor(i.amountMinor, i.currency), currency: i.currency,
      ...(i.callbackUrl ? { redirect_url: i.callbackUrl } : {}),
      customer: { email: i.email }, ...(i.planCode ? { payment_plan: i.planCode } : {}), meta: i.metadata,
      customizations: { title: 'Freebie Radar Premium' },
    });
    const link = json.data?.link;
    if (typeof link !== 'string' || !/^https:\/\//.test(link)) throw new BillingProviderError('Flutterwave did not return a checkout link', false);
    return { checkoutUrl: link };
  }

  verifyWebhook(_raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const given = headers['verif-hash'];
    const value = Array.isArray(given) ? given[0] : given;
    if (!this.o.secretHash || !value) return false;
    const a = Buffer.from(this.o.secretHash, 'utf8');
    const b = Buffer.from(value, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseEvent(raw: Buffer): BillingEvent {
    let body: Json;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new BillingProviderError('Webhook body is not JSON', false); }
    // Flutterwave documents `event` + `data`; some older payloads put the fields at the top level.
    const type = String(body?.event ?? body?.['event.type'] ?? '');
    const d: Json = body?.data ?? body ?? {};
    const email = typeof d.customer?.email === 'string' ? d.customer.email : null;

    if (type === 'charge.completed') {
      if (d.id === undefined || typeof d.tx_ref !== 'string') throw new BillingProviderError('charge.completed is missing id or tx_ref', false);
      if (d.status === 'successful') {
        if (typeof d.currency !== 'string' || !Number.isFinite(Number(d.amount))) throw new BillingProviderError('charge.completed is missing amount or currency', false);
        const currency = d.currency.toUpperCase();
        return { kind: 'PAYMENT_SUCCEEDED', eventKey: `charge.completed:${d.id}`, reference: d.tx_ref, providerPaymentRef: String(d.id), amountMinor: toMinor(d.amount, currency), currency, email };
      }
      return { kind: 'PAYMENT_FAILED', eventKey: `charge.completed:${d.id}`, reference: d.tx_ref, email };
    }
    if (type === 'subscription.cancelled') {
      const id = d.id ?? `${email ?? 'unknown'}:${d.plan?.id ?? d.plan ?? ''}`;
      return { kind: 'SUBSCRIPTION_ENDED', eventKey: `subscription.cancelled:${id}`, email };
    }
    return { kind: 'IGNORED', eventKey: `${type || 'unknown'}:${d.id ?? d.tx_ref ?? d.flw_ref ?? 'x'}`, type: type || 'unknown' };
  }

  async verifyPayment(reference: string): Promise<VerifiedPayment> {
    const json = await this.call('GET', `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    const d: Json = json.data ?? {};
    const currency = String(d.currency ?? '').toUpperCase();
    const status = d.status === 'successful' ? 'SUCCEEDED' : d.status === 'failed' ? 'FAILED' : 'PENDING';
    return { status, providerPaymentRef: String(d.id ?? ''), amountMinor: toMinor(d.amount, currency || 'USD'), currency, email: typeof d.customer?.email === 'string' ? d.customer.email : null };
  }

  async cancelSubscription(i: { email: string; planCode: string | null }): Promise<void> {
    // UNVERIFIED path: Flutterwave lists subscriptions by email, then cancels one by id.
    const list = await this.call('GET', `/v3/subscriptions?email=${encodeURIComponent(i.email)}`);
    const subs: Json[] = Array.isArray(list.data) ? list.data : [];
    const active = subs.filter((s) => s.status === 'active' && (!i.planCode || String(s.plan) === i.planCode));
    if (!active.length) throw new BillingProviderError('No active subscription was found at Flutterwave for this account', false);
    for (const s of active) await this.call('PUT', `/v3/subscriptions/${encodeURIComponent(String(s.id))}/cancel`);
  }

  async refund(i: { providerPaymentRef: string; amountMinor?: number; currency: string }) {
    // UNVERIFIED path: POST /v3/transactions/:id/refund with an optional partial amount in major units.
    const json = await this.call('POST', `/v3/transactions/${encodeURIComponent(i.providerPaymentRef)}/refund`, i.amountMinor !== undefined ? { amount: toMajor(i.amountMinor, i.currency) } : {});
    const d: Json = json.data ?? {};
    return { refundRef: String(d.id ?? i.providerPaymentRef), done: String(d.status ?? '').toLowerCase() === 'completed' };
  }
}
