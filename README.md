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
| Prisma adapter (`src/infra/prisma`), seed (`prisma/seed.ts`) | Written against the same `Repos` ports. **Not yet run: the build sandbox cannot generate the Prisma client.** Verify with `npm run test:pg` |
| Background jobs | Job bodies exist (`runExpiry`, `dispatchPending`) and are triggered by admin endpoints. **BullMQ scheduling is not wired** |
| Expo mobile app (`apps/mobile`): Discover, Map/List, Alerts, Saved, Profile, listing detail, sell flow, resale calculator, auth | Written. Type-checks and the Android JS bundle builds. **Never run on a device or simulator** |
| Admin dashboard (`apps/admin`): overview stats, moderation queue, appeals, audit log, job triggers, role-gated | Written. Type-checks and `vite build` succeeds. Not exercised against a running API in a browser |
| Image upload to object storage | Not started. The sell screen has no photo picker, and the API accepts validated `https` image URLs only |
| In-app messaging between buyer and seller | Not started. The listing screen says so and offers "Open original listing" only for external-link listings |
| Payments, promotions, subscriptions | Not implemented. Tier gating exists for alert limits only |
| Price history and trends | Not implemented (needs the persistence layer to accumulate observations) |

## Blockers

- **The Prisma adapter is unverified until `npm run test:pg` passes** on a machine with PostgreSQL. It runs the same end-to-end suite as the in-memory adapter against a `*_test` database. Fix whatever it reports; the in-memory adapter and that suite define the expected behaviour.
- The API refuses to start in production on the in-memory store. Production uses `STORE=prisma` (the default when `NODE_ENV=production`).
- No listing provider is configured. By design there is no fake data: unconfigured providers return a setup state.
- Push delivery (`ExpoPushSender`) is written but has not been exercised against Expo's service. It stays off unless `EXPO_PUSH_ENABLED=true`.

## Run

```
npm install                      # from the repo root
cp apps/api/.env.example apps/api/.env
cd apps/api
npx jest                         # 143 tests, 10 suites
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

Observed in the build sandbox: 143 tests passing, type-check clean, `nest build` succeeds, and production startup is refused for a weak `JWT_SECRET` and for the in-memory store.

## API (no URL prefix)

Auth: bearer token from `/auth/login`. "Opt" means optional auth (anonymous allowed, personalised when signed in). Rate limited globally; auth endpoints are stricter.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness |
| `POST /auth/register`, `POST /auth/login` | none | Account and token |
| `GET /me`, `PATCH /me/preferences`, `DELETE /me` | user | Profile, location and notification prefs, account deletion |
| `POST /me/personalisation/reset` | user | Reset activity-based personalisation |
| `GET /listings` | opt | Search: `q, category, freeOnly, minPrice, maxPrice, currency, condition, lat, lng, radius, unit, sort, limit, cursor` |
| `GET /listings/:id` | opt | Detail with freshness, risk label, Deal Score and evidence, safety guidance |
| `POST /listings` | user | Seller submission (price `"0"` = free; omit price = not stated; `externalUrl` = external-link source) |
| `GET /listings/mine`, `POST /listings/:id/confirm`, `POST /listings/:id/unavailable` | user | Seller management and availability evidence |
| `POST /listings/:id/report`, `POST /listings/:id/dismiss` | user | Report (distinct-reporter thresholds), hide from feeds |
| `GET /feed/free-near-me`, `GET /feed/exceptional-deals` | opt | Feeds. Exceptional deals only include evidence-backed scores |
| `GET /feed/recommended` | user | Personalised feed with an explanation string |
| `GET /saved`, `POST /saved/:id`, `DELETE /saved/:id` | user | Saved listings |
| `POST /alerts`, `GET /alerts`, `PATCH /alerts/:id`, `DELETE /alerts/:id`, `GET /alerts/history` | user | Radar Alerts (plan limits from config) |
| `POST /resale/calculate` | none | Stateless profit calculator |
| `POST /resale`, `GET /resale`, `GET /resale/compare`, `DELETE /resale/:id` | user | Saved calculations, ranked per currency |
| `POST /appeals` | user | Appeal a moderation decision on your listing |
| `GET /admin/reports`, `POST /admin/reports/:id/resolve`, `POST /admin/listings/:id/moderate`, `GET /admin/appeals`, `POST /admin/appeals/:id/resolve` | moderator, admin | Review queue and decisions (reason required, audited) |
| `GET /admin/stats`, `GET /admin/audit`, `POST /admin/jobs/expire`, `POST /admin/jobs/dispatch-alerts` | admin | Real aggregate counts, audit log, job triggers |

## Design decisions

- Money is integer minor units plus an ISO 4217 currency validated against the runtime's real currency list. Currencies are never mixed or converted when comparing prices.
- A Deal Score is produced only with at least 5 comparable listings (same country, currency and category, within 90 days). Otherwise the score is `null` with the reason. Unknown price is never treated as free. Promotion never affects scores.
- Listing status changes only on evidence (provider refresh, seller confirmation, distinct-user reports, moderators). One report never removes a listing.
- Risk output describes the listing, never the person. Heavily reported or multi-signal listings are held for human review, not auto-removed.
- Public responses expose only an approximate location (about 1 km grid) and never the seller's identity or contact details.
- Alerts are deduplicated per `(alert, listing)`, skip the user's own listings, and respect push preference, quiet hours (in the user's time zone) and a daily cap.
- Account deletion anonymises the user and removes their listings from circulation.

## Known limitations

- Pagination is offset-based in both adapters; move to keyset pagination on `(postedAt, id)` for large feeds. Radius and distance-ordered searches prefilter by bounding box in SQL (capped at 5,000 candidates) and refine in memory; PostGIS is the upgrade path.
- Deal scores are computed on read from comparable listings; production should cache scores and maintain `ComparablePriceObservation` rows.
- No refresh-token flow yet (access tokens only), no email verification or password reset, no user-to-user blocking endpoints.
- No test has been run against PostgreSQL, Redis or BullMQ.
- Mobile: not run on a device. The map uses `react-native-maps` (Android release builds need a Google Maps API key; Expo Go on iOS uses Apple Maps). Push registration needs an Expo `projectId` in `app.json` (`extra.eas.projectId`) and a real device; without it the app says push is not configured instead of pretending.
- Mobile location: one-shot foreground location on request, or a manually geocoded place. There is no background tracking. Manual geocoding uses the platform geocoder and is unverified.
- The dashboard shows only counts the API actually has. Provider failures, retention, revenue and sponsored-performance panels need the data sources behind them.
