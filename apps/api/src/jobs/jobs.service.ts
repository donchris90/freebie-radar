import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { REPOS, Repos } from '../domain/ports';
import { AlertsService } from '../engagement/alerts';
import { ListingsService } from '../listings/listings';
import { JobDef, JobRunner, JobStatus } from './runner';

/** Owns the schedule. Starts with the app when Redis is configured; stops cleanly on shutdown. */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Jobs');
  private runner: JobRunner | null = null;
  /** Extra jobs (such as source sync) register here before bootstrap. */
  private readonly extra: JobDef[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(REPOS) private readonly repos: Repos,
    private readonly listings: ListingsService,
    private readonly alerts: AlertsService,
  ) {}

  register(def: JobDef) {
    this.extra.push(def);
  }

  get enabled() {
    return !!this.runner;
  }

  private defs(): JobDef[] {
    const every = this.cfg.jobs.intervalOverrideMs;
    const list: JobDef[] = [
      { name: 'expire-listings', everyMs: 15 * 60_000, run: () => this.listings.runExpiry() },
      { name: 'dispatch-alerts', everyMs: 60_000, run: () => this.alerts.dispatchPending() },
      { name: 'purge-expired-tokens', everyMs: 6 * 3_600_000, run: async () => ({ removed: await this.repos.tokens.purgeExpired(new Date()) }) },
      ...this.extra,
    ];
    return every ? list.map((d) => ({ ...d, everyMs: every })) : list;
  }

  async onApplicationBootstrap() {
    if (!this.cfg.jobs.enabled) {
      this.log.warn('Scheduled jobs are OFF (no REDIS_URL). Listing expiry and alert dispatch will only run when an admin triggers them.');
      return;
    }
    this.runner = new JobRunner(
      {
        redisUrl: this.cfg.jobs.redisUrl!,
        queueName: this.cfg.jobs.queueName,
        log: { info: (m) => this.log.log(m), warn: (m) => this.log.warn(m), error: (m) => this.log.error(m) },
        onFailure: async (f) => {
          await this.repos.audit.add({ id: randomUUID(), actorId: null, action: 'JOB_FAILED', entityType: 'Job', entityId: f.name, metadata: { attempts: f.attempts, reason: f.reason.slice(0, 500) }, createdAt: new Date() });
        },
      },
      this.defs(),
    );
    await this.runner.start();
    this.log.log(`Scheduled jobs running: ${this.defs().map((d) => `${d.name} every ${Math.round(d.everyMs / 1000)}s`).join(', ')}`);
  }

  async onApplicationShutdown() {
    await this.runner?.stop();
  }

  async status(): Promise<{ enabled: boolean; jobs: JobStatus[] }> {
    return { enabled: this.enabled, jobs: this.runner ? await this.runner.status() : [] };
  }

  async runNow(name: string) {
    if (!this.runner) return { queued: false, reason: 'Scheduled jobs are off (no Redis). Use the direct trigger instead.' };
    return this.runner.runNow(name);
  }
}
