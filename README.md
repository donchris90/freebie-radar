# Freebie Radar

Find the deals before everyone else. A deal-discovery platform: Free Near Me, explainable Deal Scores, Radar Alerts, listing freshness, scam-risk signals and a reseller profit calculator.

## Status (honest snapshot)

| Area | State |
|---|---|
| Monorepo scaffold, `docker-compose.yml`, `.env.example` | Done |
| Core engines `apps/api/src/core` (money, geo, deal scoring, comparable eligibility, resale, duplicate detection, lifecycle/freshness, risk, alert matching and delivery planning) | Done and unit tested |
| Provider framework with bounded backoff (`src/providers`) | Done and tested |
| REST API (auth, listings, seller submissions, feeds, saved, reports, moderation, appeals, alerts, resale, admin) | Done and tested end to end over HTTP, **on the in-memory adapter only** |
| Prisma schema (`prisma/schema.prisma`, about 30 models) | Validated and migrated (`init`) on PostgreSQL 16 by the owner |
| Prisma adapter (`src/infra/prisma`), seed (`prisma/seed.ts`) | Written against the same `Repos` ports. **Observed by the owner: the 52 HTTP end-to-end tests (including countries and photo upload) pass against PostgreSQL 16** (`npm run test:pg`) |
| Background jobs (`src/jobs`) | BullMQ on Redis: listing expiry, alert dispatch, token cleanup, source sync and billing reconcile run on a schedule with retries, one-run-at-a-time, restart recovery and failure audit; Admin → Jobs shows status. Observed here against a real Redis 7 (`npm run test:redis`). Needs `REDIS_URL`; production refuses to start without it |
| Expo mobile app (`apps/mobile`): Discover, Map/List, Alerts, Saved, Profile, listing detail, sell flow, resale calculator, auth | Written. Type-checks and the Android JS bundle builds. **Never run on a device or simulator** |
| Admin dashboard (`apps/admin`): overview stats, moderation queue, appeals, audit log, job triggers, role-gated | Written. Type-checks and `vite build` succeeds. Not exercised against a running API in a browser |
| Photo upload (`POST /uploads/images`, sell-screen camera and library picker) | Built and covered by e2e tests with the local-disk driver. Photos are decoded and re-encoded (EXIF/GPS removed, max 1600px JPEG). The S3 driver is written but **never run against a real bucket** |
| In-app messaging | Built: one thread per buyer and listing, phone numbers/emails/links refused, pay-in-advance messages flagged for the recipient, daily/hourly/unanswered limits, block and report, moderator queue that only shows reported messages, closed-listing handling, mobile inbox and chat (polling every 10 s, push says only "new message"). 28 tests on the in-memory store. No real-time socket, no read receipts, no attachments |
| Listing sources (`src/sync`, `docs/LISTING_SOURCES.md`) | Partner-feed adapter and sync engine: sources start **off**, need a recorded permission note, per-source countries/expiry/attribution, paging, backoff, partial-run handling, run history, admin Sources tab, attribution shown in the app. Tested against a local fixture feed. **No real partner is connected**, so there is still no live external inventory |
| Billing (`src/billing`, `docs/BILLING.md`) | Provider-neutral core, **Flutterwave** adapter first (Stripe/Paystack can plug in). Checkout, `verif-hash` webhook check, idempotent events, amount verification, subscription lifecycle with grace period, cancel, admin refunds, reconcile job, Premium screen, admin Billing tab. 37 tests against a local stand-in server. **Not run against Flutterwave**; three of its endpoints are marked UNVERIFIED; iPhone checkout is off by default |
| Ads (`apps/mobile/src/ads.tsx`, `docs/ADS.md`) | AdMob banners for free accounts on Discover and Search only, consent-first, Google test ids by default, off unless enabled, release check blocks test ids in store builds. Plugin verified with an Android prebuild; **no ad has been seen on a device** |
| Countries (`Country` table, admin Countries page, public `GET /countries`) | US, CA and GB open at first; every other catalog country is switched on from the admin dashboard. Covered by e2e tests on the in-memory store; needs migration `countries` on PostgreSQL |
| Account safety: refresh tokens, change password, forgot/reset password, email verification, blocking sellers, admin suspend | Built; 20 new e2e tests pass **on the in-memory store only**. Needs migration `account_safety` and a `test:pg` run on PostgreSQL before it counts as verified there. Email delivery over SMTP is written against nodemailer's documented API and **never sent through a real provider** (in development the code is printed in the API console) |
| Promotions (paid listing boost) | Not implemented. Premium subscriptions are (see Billing) |
| Price history and trends | Not implemented (needs the persistence layer to accumulate observations) |

## Blockers

- The API refuses to start in production on the in-memory store. Production uses `STORE=prisma` (the default when `NODE_ENV=production`).
- No listing provider is configured. By design there is no fake data: unconfigured providers return a setup state.
- Push delivery (`ExpoPushSender`) is written but has not been exercised against Expo's service. It stays off unless `EXPO_PUSH_ENABLED=true`.

## Run

```
npm install                      # from the repo root
cp apps/api/.env.example apps/api/.env
cd apps/api
npx jest                         # 155 tests, 10 suites
npx tsc --noEmit                 # type-check
npm run build && npm start       # production build (STORE=prisma, needs PostgreSQL)
npm run start:dev                # local dev; reads apps/api/.env (STORE=prisma for PostgreSQL, STORE=memory for a quick trial)

docker compose up -d postgres redis   # PostgreSQL on host port 5434, Redis on 6381 (avoids clashing with other local projects)
npx prisma migrate deploy        # apply migrations
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' npm run seed   # sources + optional admin
npm run test:pg                  # the e2e suite against PostgreSQL (creates freebie_radar_test)
```

Mobile (`apps/mobile`) and admin (`apps/admin`):

```
cd apps/mobile && cp .env.example .env   # set EXPO_PUBLIC_API_URL to a URL your phone can reach
npx expo start                           # then open in Expo Go or a dev build
npm run typecheck                        # tsc --noEmit
npm run bundle:check                     # offline Android JS bundle (EXPO_OFFLINE=1 recommended)

cd apps/admin && cp .env.example .env    # VITE_API_URL
npm run dev                              # http://localhost:5173 (allowed by CORS_ORIGINS in dev)
npm run build                            # type-check + production build
```

To try the admin dashboard locally, register a user, then use `npm run seed` with `ADMIN_EMAIL` and `ADMIN_PASSWORD` to create an admin on PostgreSQL (the in-memory store has no seed).

Observed in the build sandbox: 155 tests passing, type-check clean, `nest build` succeeds, and production startup is refused for a weak `JWT_SECRET` and for the in-memory store.

## API (no URL prefix)

Auth: bearer token from `/auth/login`. "Opt" means optional auth (anonymous allowed, personalised when signed in). Rate limited globally; auth endpoints are stricter.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness |
| `POST /auth/register`, `POST /auth/login` | none | Account; returns `accessToken` (15 min) and `refreshToken` |
| `POST /auth/refresh`, `POST /auth/logout` | none | Rotate a refresh token (single use; replaying a used one ends that whole login) / end one login |
| `POST /auth/forgot-password`, `POST /auth/reset-password` | none | Emails an 8-character code (30 min, five guesses); reset signs out every device |
| `POST /auth/logout-everywhere`, `POST /me/password` | user | Sign out all devices; change password (current password required) |
| `POST /me/email/send-code`, `POST /me/email/verify` | user | Email verification by code. Posting requires it when `REQUIRE_VERIFIED_EMAIL` is on (default in production) |
| `POST /listings/:id/block-seller`, `GET /me/blocks`, `DELETE /me/blocks/:userId` | user | Hide a seller's listings from your feeds, search, saved list and alerts |
| `GET /me`, `PATCH /me/preferences`, `DELETE /me` | user | Profile, location and notification prefs, account deletion |
| `POST /me/personalisation/reset` | user | Reset activity-based personalisation |
| `GET /listings` | opt | Search (`freeOnly` accepts true/false/1/0): `q, category, freeOnly, minPrice, maxPrice, currency, condition, lat, lng, radius, unit, sort, limit, cursor` |
| `GET /listings/:id` | opt | Detail with freshness, risk label, Deal Score and evidence, safety guidance |
| `POST /listings` | user | Seller submission (price `"0"` = free; omit price = not stated; `externalUrl` = external-link source) |
| `GET /listings/mine`, `POST /listings/:id/confirm`, `POST /listings/:id/unavailable` | user | Seller management and availability evidence |
| `POST /listings/:id/report`, `POST /listings/:id/dismiss` | user | Report (distinct-reporter thresholds), hide from feeds |
| `GET /feed/free-near-me`, `GET /feed/exceptional-deals` | opt | Feeds. Exceptional deals only include evidence-backed scores |
| `GET /feed/recommended` | user | Personalised feed with an explanation string |
| `GET /saved`, `POST /saved/:id`, `DELETE /saved/:id` | user | Saved listings |
| `POST /alerts`, `GET /alerts`, `PATCH /alerts/:id`, `DELETE /alerts/:id`, `GET /alerts/history` | user | Radar Alerts (plan limits from config) |
| `POST /uploads/images` | user | Upload one photo (multipart field `file`, up to 8 MB; JPEG, PNG or WebP). Returns the `url` to pass in `imageUrls` |
| `GET /uploads/u/:userId/:file` | none | Serves photos stored on local disk (not used with S3) |
| `POST /resale/calculate` | none | Stateless profit calculator |
| `POST /resale`, `GET /resale`, `GET /resale/compare`, `DELETE /resale/:id` | user | Saved calculations, ranked per currency |
| `POST /appeals` | user | Appeal a moderation decision on your listing |
| `GET /admin/reports`, `POST /admin/reports/:id/resolve`, `POST /admin/listings/:id/moderate`, `GET /admin/appeals`, `POST /admin/appeals/:id/resolve` | moderator, admin | Review queue and decisions (reason required, audited) |
| `GET /countries` | none | Countries currently open (code, currency, distance unit, time zone) |
| `GET /admin/countries`, `PATCH /admin/countries/:code` | admin | List the catalog, switch a country on or off (audited; the default country cannot be disabled) |
| `GET /admin/users?email=`, `POST /admin/users/:id/status` | admin | Find an account; suspend (signs out everywhere, holds listings for review) or restore. Reason required, audited |
| `GET /conversations`, `GET /conversations/:id`, `POST /listings/:id/conversations`, `POST /conversations/:id/messages`, `POST /conversations/:id/block`, `POST /messages/:id/report` | user | In-app messaging |
| `GET /admin/message-reports`, `POST /admin/message-reports/:id/resolve` | moderator, admin | Reported messages with a little context |
| `GET /billing/plans`, `GET /billing/status`, `POST /billing/checkout`, `POST /billing/verify`, `POST /billing/cancel` | user | Premium plans, status, start/confirm/cancel |
| `POST /billing/webhook/flutterwave`, `GET /billing/return` | provider secret / none | Payment webhooks (raw body, `verif-hash`) and the page people land on after paying |
| `GET /admin/billing/payments`, `GET /admin/billing/events`, `POST /admin/billing/refund`, `POST /admin/billing/refunds/:reference/settle` | admin | Payments, webhook events (failures visible), refunds |
| `GET /admin/sources`, `GET /admin/sources/:key/runs`, `POST /admin/sources/:key/enabled`, `POST /admin/sources/:key/sync` | admin | Partner feeds: state, history, switch on/off, sync now |
| `GET /admin/jobs/status`, `POST /admin/jobs/queue/:name` | admin | Scheduled-job health and run-now |
| `GET /admin/stats`, `GET /admin/audit`, `POST /admin/jobs/expire`, `POST /admin/jobs/dispatch-alerts` | admin | Real aggregate counts, audit log, job triggers |

## Design decisions

- Which countries are open is data, not code: the `Country` table is seeded from a reference catalog (`src/core/countries.ts`), `LAUNCH_COUNTRIES` (default `US,CA,GB`) only decides the first-run set, and the admin dashboard decides after that. Disabling a country blocks new accounts and listings but never touches existing ones.
- Money is integer minor units plus an ISO 4217 currency validated against the runtime's real currency list. Currencies are never mixed or converted when comparing prices.
- A Deal Score is produced only with at least 5 comparable listings (same country, currency and category, within 90 days). Otherwise the score is `null` with the reason. Unknown price is never treated as free. Promotion never affects scores.
- Listing status changes only on evidence (provider refresh, seller confirmation, distinct-user reports, moderators). One report never removes a listing.
- Risk output describes the listing, never the person. Heavily reported or multi-signal listings are held for human review, not auto-removed.
- Public responses expose only an approximate location (about 1 km grid) and never the seller's identity or contact details.
- Alerts are deduplicated per `(alert, listing)`, skip the user's own listings, and respect push preference, quiet hours (in the user's time zone) and a daily cap.
- Account deletion anonymises the user and removes their listings from circulation.

## Known limitations

- Photos: no thumbnails yet (feeds load the 1600px image), no cleanup job for uploads never attached to a listing, no per-user storage quota beyond the rate limit (30 uploads per minute). Photos are deleted when an account is deleted. In production use `STORAGE_DRIVER=s3` (S3-compatible: AWS, R2, MinIO) with `S3_PUBLIC_BASE_URL`; local disk needs `PUBLIC_BASE_URL` and persistent storage.
- Pagination is offset-based in both adapters; move to keyset pagination on `(postedAt, id)` for large feeds. Radius and distance-ordered searches prefilter by bounding box in SQL (capped at 5,000 candidates) and refine in memory; PostGIS is the upgrade path.
- Deal scores are computed on read from comparable listings; production should cache scores and maintain `ComparablePriceObservation` rows.
- Account safety: access tokens last 15 minutes and are ended early by a per-user version counter; refresh tokens last 30 days and rotate on use. Codes are emailed, not sent as links, so no web page or deep link is needed. Blocking is one-way (the blocked person is not told and can still see the blocker's listings). Suspending holds public listings for review; restoring access does not republish them. No two-factor sign-in, no CAPTCHA, and no per-account lockout beyond rate limits and the five-guess cap on codes.
- The HTTP e2e suite has run against PostgreSQL only up to the countries/photo-upload work. Account safety, sources, messaging and billing have new tables (`prisma/schema.prisma`) that were **never migrated or run on PostgreSQL**; the Prisma code for them is untested. Run `npx prisma migrate dev` and `npm run test:pg` before trusting them. The Redis-backed job tests pass (`npm run test:redis`).
- The exceptional-deals feed scores the newest 300 matches per request (it says when it was cut short); stored scores are the real fix at scale.
- Messaging has no real-time channel or retention policy; reports are the only way staff see a message.
- Mobile: not run on a device. The map uses `react-native-maps` (Android release builds need a Google Maps API key; Expo Go on iOS uses Apple Maps). Push registration needs an Expo `projectId` in `app.json` (`extra.eas.projectId`) and a real device; without it the app says push is not configured instead of pretending.
- Mobile location: one-shot foreground location on request, or a manually geocoded place. There is no background tracking. Manual geocoding uses the platform geocoder and is unverified.
- The dashboard shows only counts the API actually has. Provider failures, retention, revenue and sponsored-performance panels need the data sources behind them.

## Community features
Reservations ("I'll take it"), Spotted curb finds, public share pages, referral/ambassador codes, organisation CSV import and a pickup reliability signal. See `docs/SETUP_WINDOWS.md` for settings and how each behaves.
