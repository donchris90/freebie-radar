# Freebie Radar

Find the deals before everyone else. A deal-discovery platform: Free Near Me, explainable Deal Scores, Radar Alerts, listing freshness, scam-risk signals and a reseller profit calculator.

## Status (honest snapshot)

| Area | State |
|---|---|
| Monorepo scaffold, `docker-compose.yml`, `.env.example` | Done |
| Prisma schema (`apps/api/prisma/schema.prisma`, ~30 models) | Written and not yet validated or migrated (see Blockers) |
| Core engines in `apps/api/src/core` (money, geo, deal scoring, comparable eligibility, resale calculator, duplicate detection, lifecycle and freshness, risk, alert matching and delivery planning) | Done, 100 unit tests passing |
| Provider framework with bounded backoff (`apps/api/src/providers`) | Done, tested |
| NestJS modules and endpoints (auth, listings, seller submissions, alerts, reports, moderation, admin) | Not started |
| Background jobs (BullMQ) | Not started |
| Expo mobile app, admin dashboard | Not started |
| Payments | Not implemented. Provider abstraction only after country, currency and business eligibility are confirmed |

## Blockers

- **Prisma engines cannot be downloaded in the build sandbox** (`binaries.prisma.sh` is denied by the egress proxy). `prisma validate`, `generate` and `migrate` have therefore not been run and no migration exists yet. On a machine with normal network access run `npx prisma migrate dev --name init` in `apps/api`.
- No listing provider is configured. By design there is no fake data: unconfigured providers return a setup state.

## Run the tests

```
cd apps/api
npm install
npx jest          # 100 tests across 9 suites
npx tsc --noEmit  # type-check
```

## Design decisions

- Money is integer minor units plus an ISO 4217 currency. Currencies are never mixed or converted when comparing prices.
- A Deal Score is produced only with at least 5 comparable listings (same country, currency and category, within 90 days). Otherwise the score is `null` with the reason. Unknown price is never treated as free. Promotion never affects scores.
- Listing status changes only on evidence (provider refresh, seller confirmation, distinct-user reports, moderators). One report never removes a listing.
- Risk output describes the listing, never the person, and never labels anyone a criminal.
- Public APIs expose only approximate locations (rounded to about 1 km).
- Alerts are deduplicated by a unique `(subscriptionId, listingId)` constraint and respect push preference, quiet hours and a daily cap.
