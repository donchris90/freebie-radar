# Freebie Radar

Find the deals before everyone else. A deal-discovery platform: Free Near Me, explainable Deal Scores, Radar Alerts, listing freshness, scam-risk signals and a reseller profit calculator.

## Status (honest snapshot)

| Area | State |
|---|---|
| Monorepo scaffold, `docker-compose.yml`, `.env.example` | Done |
| Core engines `apps/api/src/core` (money, geo, deal scoring, comparable eligibility, resale, duplicate detection, lifecycle/freshness, risk, alert matching and delivery planning) | Done and unit tested |
| Provider framework with bounded backoff (`src/providers`) | Done and tested |
| REST API (auth, listings, seller submissions, feeds, saved, reports, moderation, appeals, alerts, resale, admin) | Done and tested end to end over HTTP, **on the in-memory adapter only** |
| Prisma schema (`prisma/schema.prisma`, about 30 models) | Written. **Not validated, no migration generated, no Prisma adapter yet** (see Blockers) |
| Background jobs | Job bodies exist (`runExpiry`, `dispatchPending`) and are triggered by admin endpoints. **BullMQ scheduling is not wired** |
| Expo mobile app, admin web dashboard | Not started |
| Image upload to object storage | Not started (listings accept validated `https` image URLs only) |
| Payments, promotions, subscriptions | Not implemented. Tier gating exists for alert limits only |
| Price history and trends | Not implemented (needs the persistence layer to accumulate observations) |

## Blockers

- **Prisma engines cannot be downloaded in the build sandbox**: `binaries.prisma.sh` is denied by the egress proxy, and even `prisma generate` needs it. So `prisma validate/generate/migrate` have never been run. On a machine with normal network access:
  ```
  cd apps/api && npx prisma migrate dev --name init
  ```
  This produces the real migration from `schema.prisma`. Then implement `Repos` (`src/domain/ports.ts`) with Prisma. The in-memory adapter and the end-to-end suite define the exact behaviour to match.
- **The API refuses to start in production** until that adapter exists, because the in-memory store would lose data. This is deliberate.
- No listing provider is configured. By design there is no fake data: unconfigured providers return a setup state.
- Push delivery (`ExpoPushSender`) is written but has not been exercised against Expo's service. It stays off unless `EXPO_PUSH_ENABLED=true`.

## Run

```
npm install                      # from the repo root
cp apps/api/.env.example apps/api/.env
cd apps/api
npx jest                         # 142 tests, 10 suites
npx tsc --noEmit                 # type-check
npm run build && npm start       # production build (needs a persistence adapter, see Blockers)
npm run start:dev                # local dev with the in-memory adapter
```

Observed in the build sandbox: 142 tests passing, type-check clean, `nest build` succeeds, and production startup is refused for a weak `JWT_SECRET` and for the in-memory store.

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

- Pagination in the in-memory adapter is offset-based; the Prisma adapter should use keyset pagination on `(postedAt, id)`.
- Deal scores are computed on read from comparable listings; production should cache scores and maintain `ComparablePriceObservation` rows.
- No refresh-token flow yet (access tokens only), no email verification or password reset, no user-to-user blocking endpoints.
- No test has been run against PostgreSQL, Redis or BullMQ.
