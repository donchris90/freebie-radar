import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CountriesService } from '../countries/countries.service';
import { canonicalizeUrl, contentHash, DedupListing, findDuplicates } from '../core/dedup';
import { canTransition, transition } from '../core/lifecycle';
import { assertCurrency } from '../core/money';
import { assessRisk } from '../core/risk';
import { ListingRec, SourceRec, SyncRunRec, SyncStatus } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';
import { AlertsService } from '../engagement/alerts';
import { JobsService } from '../jobs/jobs.service';
import { BackoffOptions, fetchPageSafely, ListingProvider, NormalizedListing } from '../providers/provider';

/** A provider plus the descriptive/freshness settings its source row is created from. */
export interface RegisteredSource {
  provider: ListingProvider;
  defaults: Omit<SourceRec, 'enabled'>;
}
export const SOURCES = Symbol('SOURCES');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SyncResult {
  sourceKey: string;
  status: SyncStatus;
  fetched: number;
  created: number;
  updated: number;
  rejected: number;
  message?: string;
  runId?: string;
}

type ItemOutcome = 'created' | 'updated' | 'rejected' | 'skipped';

/**
 * Pulls listings from authorised partner sources. A source is only read when an admin has switched it on,
 * its credentials are present and the country is both enabled here and covered by the source. Every run is
 * recorded. The sync only ever stores what the feed sends; it does not guess, fill in or scrape.
 *
 * Freshness: a feed is a snapshot of what is available now. Each run re-confirms what it returns, so listings
 * the feed stops sending are not touched and age out by the source's own expire/retire hours.
 */
@Injectable()
export class SyncService implements OnModuleInit {
  private readonly log = new Logger('Sync');
  private readonly running = new Set<string>();
  /** Overridable so tests need not wait on real backoff or pacing. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  backoff: BackoffOptions = {};

  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(SOURCES) private readonly registered: RegisteredSource[],
    private readonly countries: CountriesService,
    private readonly alerts: AlertsService,
    jobs: JobsService,
  ) {
    if (registered.length) jobs.register({ name: 'sync-sources', everyMs: cfg.sync.everyMs, run: () => this.syncAll() });
  }

  async onModuleInit() {
    for (const r of this.registered) {
      // New sources start OFF: an admin switches one on after checking the written permission.
      await this.repos.sources.upsertConfig({ ...r.defaults, enabled: false });
    }
  }

  /** Providers known to this deployment, with whether they are ready to run. */
  async overview() {
    const sources = new Map((await this.repos.sources.list()).map((s) => [s.key, s]));
    const out = [];
    for (const r of this.registered) {
      const s = sources.get(r.provider.key);
      out.push({
        ...(s ?? { ...r.defaults, enabled: false }),
        configured: r.provider.isConfigured(),
        setup: r.provider.isConfigured() ? null : r.provider.setupInstructions(),
        capabilities: r.provider.capabilities,
        lastRun: (await this.repos.syncRuns.recent(r.provider.key, 1))[0] ?? null,
        lastOkAt: await this.repos.syncRuns.lastOkStartedAt(r.provider.key),
      });
    }
    return out;
  }

  async syncAll() {
    const results: SyncResult[] = [];
    for (const r of this.registered) results.push(await this.syncSource(r.provider.key));
    return { sources: results.length, created: sum(results, 'created'), updated: sum(results, 'updated'), rejected: sum(results, 'rejected'), failed: results.filter((x) => x.status === 'FAILED' || x.status === 'RATE_LIMITED').length };
  }

  async syncSource(key: string, now = () => new Date()): Promise<SyncResult> {
    const reg = this.registered.find((r) => r.provider.key === key);
    const base = { sourceKey: key, fetched: 0, created: 0, updated: 0, rejected: 0 };
    if (!reg) return { ...base, status: 'SKIPPED', message: 'Unknown source' };
    const source = await this.repos.sources.get(key);
    if (!source?.enabled) return { ...base, status: 'SKIPPED', message: 'Source is switched off' };
    if (this.running.has(key)) return { ...base, status: 'SKIPPED', message: 'A sync for this source is already running' };
    this.running.add(key);

    const run: SyncRunRec = { id: randomUUID(), sourceKey: key, startedAt: now(), finishedAt: null, status: 'RUNNING', ...zeroCounts(), errorMessage: null };
    await this.repos.syncRuns.start(run);
    const totals = zeroCounts();
    let status: SyncStatus = 'OK';
    let message: string | undefined;
    try {
      const enabledCountries = (await this.countries.enabled()).map((c) => c.code);
      const wanted = enabledCountries.filter((c) => (source.countries.length === 0 || source.countries.includes(c)) && reg.provider.supportsCountry(c));
      const startedMs = Date.now();
      const gapMs = source.rateLimitPerMinute ? Math.ceil(60_000 / source.rateLimitPerMinute) : 0;

      outer: for (const country of wanted) {
        let cursor: string | null = null;
        for (let page = 0; page < this.cfg.sync.maxPages; page++) {
          if (Date.now() - startedMs > this.cfg.sync.maxRunMs) { status = 'PARTIAL'; message = 'Stopped at the time limit; the next run starts over.'; break outer; }
          if (page > 0 && gapMs) await this.sleep(gapMs);
          const out = await fetchPageSafely(reg.provider, { cursor, limit: this.cfg.sync.pageSize, countryCode: country }, this.backoff);
          if (out.state !== 'OK') {
            if (out.state === 'COUNTRY_UNSUPPORTED') break;
            status = worstOf(status, out.state === 'RATE_LIMITED' ? 'RATE_LIMITED' : out.state === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'FAILED');
            message = `${country}: ${out.message ?? out.state}`;
            // Partial work is kept: what was stored is real. The run is marked so an admin can see it was cut short.
            if (totals.created + totals.updated > 0 && status === 'FAILED') status = 'PARTIAL';
            break outer;
          }
          totals.rejected += out.rejected ?? 0;
          for (const item of out.items) {
            totals.fetched++;
            const o = await this.processItem(source, country, item, now());
            totals[o === 'skipped' ? 'rejected' : o]++;
          }
          cursor = out.nextCursor ?? null;
          if (!cursor) break;
        }
      }
    } catch (e) {
      status = 'FAILED';
      message = e instanceof Error ? e.message : String(e);
      this.log.error(`Sync of ${key} failed: ${message}`);
    } finally {
      this.running.delete(key);
    }
    await this.repos.syncRuns.finish(run.id, { status, ...totals, errorMessage: message ? message.slice(0, 500) : null }, now());
    return { sourceKey: key, status, ...totals, message, runId: run.id };
  }

  private async processItem(source: SourceRec, country: string, item: NormalizedListing, now: Date): Promise<ItemOutcome> {
    // A feed asked for GB must not hand us listings in another country.
    if (item.countryCode && item.countryCode.toUpperCase() !== country) return 'rejected';
    if (item.lat === undefined || item.lng === undefined || !item.url) return 'rejected';
    const key = source.key;
    const existing = await this.repos.listings.findBySourceExternal(key, item.externalId);
    const available = item.available !== false;

    if (existing) {
      if (!available) {
        // The source itself says it is gone: that is evidence, so hide it now rather than wait for expiry.
        if (canTransition(existing.status, 'RECHECK_GONE')) {
          await this.repos.listings.update(existing.id, { status: transition(existing.status, 'RECHECK_GONE') });
          return 'updated';
        }
        return 'skipped';
      }
      const patch: Partial<ListingRec> = { ...(await this.fields(country, item)), lastConfirmedAt: now, expiresAt: null };
      // Moderated states (under review, removed, confirmed unavailable) are never reversed by a feed refresh.
      if (canTransition(existing.status, 'PROVIDER_REFRESH')) patch.status = transition(existing.status, 'PROVIDER_REFRESH');
      await this.repos.listings.update(existing.id, patch);
      return 'updated';
    }
    if (!available) return 'skipped'; // never create a listing that is already gone

    const f = await this.fields(country, item);
    const risk = assessRisk({ title: f.title, description: f.description, priceMinor: f.priceMinor, isFree: f.isFree, condition: f.condition, comparableSampleSize: 0 });
    const posted = item.postedAt && item.postedAt.getTime() <= now.getTime() ? item.postedAt : now;
    const rec: ListingRec = {
      id: randomUUID(),
      sourceKey: key,
      externalId: item.externalId,
      sellerUserId: null,
      riskLevel: risk.level,
      riskSignals: risk.signals,
      status: risk.level === 'UNDER_REVIEW' ? 'UNDER_REVIEW' : 'ACTIVE',
      duplicateOfId: null,
      isPromoted: false,
      postedAt: posted,
      lastConfirmedAt: now,
      expiresAt: null,
      contactMethod: 'EXTERNAL_LINK',
      ...f,
    };

    // The same item listed by another source or a user is linked, not shown twice.
    const toDedup = (l: ListingRec): DedupListing => ({ id: l.id, sourceId: l.sourceKey, externalId: l.externalId, canonicalUrl: l.canonicalUrl, title: l.title, description: l.description, priceMinor: l.priceMinor, currency: l.currency, lat: l.lat, lng: l.lng, sellerUserId: l.sellerUserId });
    const near = await this.repos.listings.findNear(rec.lat, rec.lng, 2);
    const dup = findDuplicates(toDedup(rec), near.map(toDedup));
    if (dup.autoLinkable) rec.duplicateOfId = dup.autoLinkable.listing.id;

    let saved: ListingRec;
    try {
      saved = await this.repos.listings.insert(rec);
    } catch (e) {
      if (e instanceof Error && /Duplicate \(sourceKey, externalId\)/.test(e.message)) return 'skipped'; // lost a race with another run
      throw e;
    }
    if (saved.status === 'ACTIVE' && !saved.duplicateOfId) {
      try { await this.alerts.processNewListing(saved, now); } catch (e) { this.log.warn(`Alert matching failed for ${saved.id}: ${(e as Error).message}`); }
    }
    return 'created';
  }

  private async fields(country: string, item: NormalizedListing): Promise<FeedFields> {
    const c = await this.countries.getEnabled(country);
    const currency = assertCurrency(item.currency ?? c?.currency ?? this.cfg.defaultCurrency);
    const description = item.description?.trim() ?? '';
    const categoryKey = item.categoryKey && this.cfg.categories.includes(item.categoryKey) ? item.categoryKey : this.cfg.categories.includes('other') ? 'other' : this.cfg.categories[0];
    const priceMinor = item.priceMinor ?? null; // unknown stays unknown; it is never treated as free
    return {
      title: item.title.trim(),
      description,
      categoryKey,
      condition: (item.condition as ListingRec['condition']) ?? 'UNKNOWN',
      priceMinor,
      currency,
      isFree: priceMinor === 0,
      countryCode: country,
      lat: item.lat!,
      lng: item.lng!,
      locationLabel: null,
      externalUrl: item.url!,
      canonicalUrl: canonicalizeUrl(item.url!),
      contentHash: contentHash(item.title, description),
      imageUrls: item.imageUrls ?? [],
    };
  }
}

type FeedFields = Pick<ListingRec, 'title' | 'description' | 'categoryKey' | 'condition' | 'priceMinor' | 'currency' | 'isFree' | 'countryCode' | 'lat' | 'lng' | 'locationLabel' | 'externalUrl' | 'canonicalUrl' | 'contentHash' | 'imageUrls'>;
const zeroCounts = () => ({ fetched: 0, created: 0, updated: 0, rejected: 0 });
const sum = (rs: SyncResult[], k: 'created' | 'updated' | 'rejected') => rs.reduce((a, r) => a + r[k], 0);
const RANK: SyncStatus[] = ['OK', 'PARTIAL', 'NOT_CONFIGURED', 'RATE_LIMITED', 'FAILED'];
const worstOf = (a: SyncStatus, b: SyncStatus): SyncStatus => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a);
