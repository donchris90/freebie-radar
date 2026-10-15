import { ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfig, APP_CONFIG } from '../config/config';
import { COUNTRY_CATALOG } from '../core/countries';
import type { CountryRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';

const CACHE_MS = 15_000;

/**
 * Which countries are open for accounts and listings. The set lives in the database and is switched
 * from the admin dashboard. Reads are cached briefly; changes made through this instance apply at once,
 * other instances catch up within CACHE_MS.
 */
@Injectable()
export class CountriesService implements OnModuleInit {
  private cache: { at: number; byCode: Map<string, CountryRec> } | null = null;
  private seeded: Promise<void> | null = null;

  constructor(@Inject(REPOS) private readonly repos: Repos, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async onModuleInit() {
    await this.ensureCatalog();
  }

  /** Adds catalog countries that are missing. Existing rows (and the admin's on/off choices) are never touched. */
  ensureCatalog(): Promise<void> {
    this.seeded ??= (async () => {
      for (const x of COUNTRY_CATALOG) {
        await this.repos.countries.insertIfMissing({ ...x, enabled: this.cfg.launchCountries.includes(x.code) });
      }
    })().catch((e) => {
      this.seeded = null; // retry on the next call instead of staying broken
      throw e;
    });
    return this.seeded;
  }

  private async load(): Promise<Map<string, CountryRec>> {
    await this.ensureCatalog();
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.byCode;
    const byCode = new Map((await this.repos.countries.list()).map((c) => [c.code, c]));
    this.cache = { at: Date.now(), byCode };
    return byCode;
  }

  async all(): Promise<CountryRec[]> {
    return [...(await this.load()).values()];
  }

  async enabled(): Promise<CountryRec[]> {
    return (await this.all()).filter((c) => c.enabled);
  }

  /** The country only when it exists and is switched on; otherwise null. */
  async getEnabled(code: string): Promise<CountryRec | null> {
    const c = (await this.load()).get(code.toUpperCase());
    return c?.enabled ? c : null;
  }

  async setEnabled(actorId: string, code: string, enabled: boolean): Promise<CountryRec> {
    const upper = code.toUpperCase();
    const current = (await this.load()).get(upper);
    if (!current) throw new NotFoundException('Unknown country');
    if (current.enabled === enabled) return current;
    if (!enabled) {
      if (upper === this.cfg.defaultCountry) throw new ConflictException(`${upper} is the default country and cannot be disabled`);
      if ((await this.enabled()).length <= 1) throw new ConflictException('At least one country must stay enabled');
    }
    const updated = await this.repos.countries.setEnabled(upper, enabled);
    if (!updated) throw new NotFoundException('Unknown country');
    this.cache = null;
    await this.repos.audit.add({
      id: randomUUID(),
      actorId,
      action: enabled ? 'COUNTRY_ENABLED' : 'COUNTRY_DISABLED',
      entityType: 'Country',
      entityId: upper,
      metadata: {},
      createdAt: new Date(),
    });
    return updated;
  }
}
