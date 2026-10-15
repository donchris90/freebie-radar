# Listing sources

Freebie Radar only shows listings from people who posted them here, or from a partner that has agreed in writing to supply them. It does not scrape websites, and it never invents listings.

## What counts as a legitimate source

A partner feed is acceptable only when **all** of these are true:

1. There is a written agreement, API licence or published terms that let us store and display the listings in this app.
2. The agreement says how the partner must be credited. That text goes in `PARTNER_FEED_<KEY>_ATTRIBUTION` and is shown on every listing from that partner.
3. We know which countries the partner covers.
4. We know how long a listing may be shown without being re-confirmed.

The API refuses to switch a source on until `PARTNER_FEED_<KEY>_PERMISSION_NOTE` records where that permission lives (agreement date and reference). The note is a record for your team; the software cannot judge whether it is true.

Public marketplaces (eBay, Facebook Marketplace, Craigslist, Gumtree, OLX, Jiji) are **not** sources until their own API terms have been read and approved for this use. A real adapter for one of them is a separate piece of work: implement `ListingProvider` in `apps/api/src/providers/provider.ts`, declare only the capabilities it genuinely offers, and add its terms to this file.

## The feed contract

The built-in adapter (`JsonFeedProvider`) reads one HTTPS endpoint:

```
GET {PARTNER_FEED_<KEY>_URL}?country=GB&limit=100&cursor=<opaque>
Authorization: Bearer <PARTNER_FEED_<KEY>_API_KEY>
```

```json
{
  "items": [
    {
      "id": "stable-id-within-the-partner",
      "title": "Oak desk",
      "description": "Optional, up to 5000 characters",
      "url": "https://partner.example/items/123",
      "location": { "lat": 51.5072, "lng": -0.1276, "country": "GB" },
      "price": { "amount": "12.50", "currency": "GBP" },
      "category": "furniture",
      "condition": "good",
      "images": ["https://cdn.partner.example/123.jpg"],
      "posted_at": "2026-10-01T10:00:00Z",
      "updated_at": "2026-10-02T09:00:00Z",
      "available": true
    }
  ],
  "next_cursor": "opaque-string-or-null"
}
```

Rules we enforce (an item that breaks one is dropped and counted as *rejected*; it is never repaired):

| Field | Rule |
|---|---|
| `id`, `title`, `url`, `location` | required. `url` must be `https`. `lat`/`lng` must be numbers in range, `country` two letters |
| `price` | optional. `amount` is a decimal **string**. Leave `price` out if unknown; **only `"0.00"` means free** |
| `category` | one of our category keys, otherwise stored as `other` |
| `condition` | `new`, `like_new`, `good`, `fair`, `poor`, `for_parts`; anything else is `UNKNOWN` |
| `images` | only `https` links, at most 8 |
| `available` | `false` hides the listing at once. Default `true` |
| country | an item must be in the country that was asked for |

Responses: `429` (with `Retry-After`), `5xx`, timeouts and non-JSON bodies are retried with backoff. `401`/`403` and other `4xx` are not retried and fail the run with a clear message.

**The feed must be a snapshot of what is available now.** Each run re-confirms what it returns. Listings the feed stops sending are not deleted; they become "possibly expired" after `…_EXPIRE_HOURS` (default 48) and are retired `…_RETIRE_HOURS` (default 72) later. Set the expiry to at least twice the sync interval.

## Configuration

```
PARTNER_FEEDS=acme
PARTNER_FEED_ACME_NAME=Acme Giveaways
PARTNER_FEED_ACME_URL=https://api.acme.example/v1/listings
PARTNER_FEED_ACME_API_KEY=...
PARTNER_FEED_ACME_COUNTRIES=US,GB        # empty = every enabled country
PARTNER_FEED_ACME_ATTRIBUTION=Listings supplied by Acme Giveaways
PARTNER_FEED_ACME_ATTRIBUTION_URL=https://acme.example
PARTNER_FEED_ACME_PERMISSION_NOTE=Agreement signed 2026-09-30, ref FR-1
PARTNER_FEED_ACME_EXPIRE_HOURS=48
PARTNER_FEED_ACME_RETIRE_HOURS=72
PARTNER_FEED_ACME_RATE_LIMIT_PER_MINUTE=60   # optional pacing between pages
SYNC_INTERVAL_MINUTES=60                     # how often the scheduled job runs
```

Several partners: `PARTNER_FEEDS=acme,other` with a block of variables per key (dashes in a key become underscores).

## Operating it

1. Deploy with the variables above and Redis (the sync runs as the `sync-sources` scheduled job).
2. Admin dashboard → **Sources**. The source starts **off**. Check the permission note, then switch it on.
3. **Sync now** runs it immediately. Each run is recorded with fetched / new / refreshed / rejected counts and any error.
4. A country is only fetched when it is enabled under **Countries** *and* covered by the source.
5. Switching a source off stops all contact with the partner. Existing listings age out normally.

## What listings from a partner look like to a buyer

Contact is through the partner's page ("Open original listing"); no seller account exists, so there is nothing to message or block. The partner's attribution text and link are shown on the listing, which says it is not independently verified. Listings pass the same scam-signal rules and duplicate linking as any other.

## Not covered yet

- Incremental sync (`updated_since`). Each run re-reads the whole feed for each country.
- Re-checking individual listings (`recheck`). The adapter declares that it cannot.
- Real-partner verification. The adapter is tested against a local fixture server that follows this contract, not against any live partner.
