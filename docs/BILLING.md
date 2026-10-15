# Billing

Premium is a monthly subscription. Money moves through a payment provider; this app never sees card details. The billing code talks to a provider-neutral port (`apps/api/src/billing/provider.ts`). **Flutterwave** is the first adapter. Stripe or Paystack plug in by implementing the same interface and adding one line in `app.module.ts`.

## What Premium gives

Up to 25 saved alerts (free: 3) and no ads. Nothing else is promised in the app. Paid promotion of listings is **not built**; the database has the tables for it but no checkout.

## How a payment flows

1. App → `POST /billing/checkout`. The API records a `PENDING` payment with our own reference and the price **we** set, then asks Flutterwave for a hosted checkout link (amount, currency, `tx_ref`, payment plan).
2. The person pays on Flutterwave's page in their browser.
3. Flutterwave calls `POST /billing/webhook/flutterwave` with a `verif-hash` header. We reject anything whose header is not our secret hash (constant-time compare).
4. `charge.completed` + `successful` marks the payment `SUCCEEDED` **once** (atomic) and grants Premium for one interval. The amount and currency must equal what we recorded at checkout; anything else is marked `FAILED / AMOUNT_MISMATCH`, audited, and grants nothing.
5. When the person returns to the app it calls `POST /billing/verify`, which asks Flutterwave directly. Access does not depend on the webhook arriving first.
6. Renewals arrive as more `charge.completed` events for an existing subscriber and extend the period by one interval. A failed charge makes the subscription `PAST_DUE` (access continues for `BILLING_GRACE_DAYS`, default 3). `subscription.cancelled` ends renewal; access runs to the end of the paid period.
7. A scheduled job (`billing-reconcile`, every 15 min) checks stale checkouts with Flutterwave (so a lost webhook does not lose a payment), marks unpaid ones `ABANDONED` after 24 h, and removes lapsed access.

## Reliability rules

- **Idempotent.** Each webhook is recorded by event name + the object's own id (Flutterwave sends no event id, and documents that duplicates happen). A repeat returns 200 and does nothing. A charge seen under a different event id is recognised by its provider payment id.
- **Failures are retried by the provider.** If processing throws, the event is stored as `FAILED`, the API answers 500, and Flutterwave retries (when retries are on in the dashboard). A payment is never left "paid but not granted": the status is rolled back so the retry finishes the job.
- **Failed events are visible** in Admin → Billing → Webhook events.
- **Refunds** (Admin → Billing): sent to Flutterwave; a full refund ends Premium immediately and cancels the provider subscription. Flutterwave documents no refund webhook, so a refund the provider has not completed shows as `refund pending` until an admin confirms it from the Flutterwave dashboard.

## Configuration

```
BILLING_PROVIDER=flutterwave
FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-...          # test key until the flow is proven; production refuses test keys
FLUTTERWAVE_SECRET_HASH=a-long-random-string     # same value as Settings → Webhooks → Secret hash
PREMIUM_MONTHLY_PRICES=NGN:1500,USD:3.99         # major units; the price shown AND the price enforced
FLUTTERWAVE_PREMIUM_MONTHLY_PLAN_IDS=NGN:12345,USD:12346   # payment plans created on the dashboard, amount/currency must match
BILLING_GRACE_DAYS=3
BILLING_ALLOW_IOS=false
PUBLIC_BASE_URL=https://api.yourdomain.com       # the payment page sends people back to {PUBLIC_BASE_URL}/billing/return
```

Webhook URL to enter in the Flutterwave dashboard: `https://api.yourdomain.com/billing/webhook/flutterwave`. Turn webhook retries on.

## Before taking real money (not done, cannot be done from here)

1. **Eligibility for your business.** Flutterwave is a Nigerian company and supports Nigerian merchants, but I have not verified your account. Confirm with Flutterwave: your business is approved, **payment plans / recurring card billing** is enabled, which currencies you can charge **and settle** (the plan currency must match the charge currency), and the fees. A user in the US, Canada or UK is charged in whichever configured currency is offered (USD by default); add `GBP:`/`CAD:` prices and plans only if your account supports them.
2. **Test the whole flow in Flutterwave test mode**, with their test cards: first payment, renewal, failed renewal, cancel, refund. The adapter has only been run against a local stand-in server that follows Flutterwave's published API. Three calls are marked **UNVERIFIED** in `flutterwave.ts` because their exact paths were not in the documentation I could read: list subscriptions by email, cancel a subscription, refund a transaction. Check them against the API reference.
3. **App store rules.** Selling digital features inside an iPhone app normally requires Apple's in-app purchase. `BILLING_ALLOW_IOS` is **off**, so the iPhone app shows "not available" instead of a checkout. Apple's rules differ by country and change; take advice before turning it on. Google Play has similar rules for Android in some regions (the UK among them). Selling on the web and signing in to the app is the safe path; opening a browser checkout from the Android app may also be restricted where Play Billing is required. Decide this before launch.
4. **Tax and receipts.** Nothing here computes VAT/sales tax or issues invoices. Flutterwave's receipts are the only receipts.
5. **Terms and refunds policy** shown to users: write and publish one.

## Not built

Promotion checkout; annual plan prices (the code supports an `annual` interval, the config does not expose it); proration or plan changes; invoices; dunning emails; a user-facing refund request (refunds are admin-initiated).
