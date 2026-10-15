/**
 * Provider-neutral billing port. The billing service speaks only this interface; Flutterwave is the first
 * adapter. Stripe or Paystack plug in by implementing it and registering in app.module (see docs/BILLING.md).
 * Providers translate their own webhooks into the normalised events below and never decide entitlements.
 */

export type BillingEvent =
  | { kind: 'PAYMENT_SUCCEEDED'; eventKey: string; reference: string; providerPaymentRef: string; amountMinor: number; currency: string; email: string | null }
  | { kind: 'PAYMENT_FAILED'; eventKey: string; reference: string; email: string | null }
  | { kind: 'SUBSCRIPTION_ENDED'; eventKey: string; email: string | null }
  | { kind: 'IGNORED'; eventKey: string; type: string };

export interface CheckoutInput {
  email: string;
  amountMinor: number;
  currency: string;
  reference: string;
  /** Provider-side plan identifier for recurring billing, when the plan has one for this currency. */
  planCode: string | null;
  callbackUrl: string | null;
  metadata: Record<string, string>;
}

export interface VerifiedPayment {
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  providerPaymentRef: string;
  amountMinor: number;
  currency: string;
  email: string | null;
}

export class BillingProviderError extends Error {
  constructor(message: string, public readonly transient = true) {
    super(message);
  }
}

export interface BillingProvider {
  readonly key: string;
  readonly name: string;
  isConfigured(): boolean;
  setupInstructions(): string;
  supportsCurrency(currency: string): boolean;
  createCheckout(input: CheckoutInput): Promise<{ checkoutUrl: string }>;
  /** Authenticates a webhook delivery. Must compare in constant time. `headers` are lower-cased. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseEvent(rawBody: Buffer): BillingEvent;
  verifyPayment(reference: string): Promise<VerifiedPayment>;
  /** Stops future renewals for the customer's subscription to the plan. */
  cancelSubscription(input: { email: string; planCode: string | null }): Promise<void>;
  /** `done` is true when the provider has completed the refund; otherwise it is pending. */
  refund(input: { providerPaymentRef: string; amountMinor?: number; currency: string }): Promise<{ refundRef: string; done: boolean }>;
}

export const BILLING_PROVIDERS = Symbol('BILLING_PROVIDERS');
