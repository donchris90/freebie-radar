import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

/**
 * A small, durable job runner on BullMQ + Redis.
 *
 * - Schedules live in Redis under stable ids, so restarting (or running several API instances) never creates duplicates.
 * - Only one job runs at a time across all instances (global concurrency 1), so a slow run is never overlapped.
 * - Failed runs retry with exponential backoff; a run that exhausts its retries is reported through `onFailure`.
 * - A worker that dies mid-run leaves a stalled job that another worker picks up after the lock expires.
 */

export interface JobDef {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

export interface FailureInfo {
  name: string;
  attempts: number;
  reason: string;
}

export interface RunnerOptions {
  redisUrl: string;
  queueName?: string;
  attempts?: number;
  backoffMs?: number;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  runTimeoutMs?: number;
  onFailure?: (info: FailureInfo) => void | Promise<void>;
  log?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface JobStatus {
  name: string;
  everyMs: number;
  nextRunAt: string | null;
  lastSuccess: { at: string; result: unknown } | null;
  lastFailure: { at: string; reason: string; attempts: number } | null;
  /** True when nothing has succeeded for three intervals: the schedule is not keeping up. */
  stale: boolean;
}

const silent = { info() {}, warn() {}, error() {} };

export class JobRunner {
  private queue!: Queue;
  private worker!: Worker;
  private conns: IORedis[] = [];
  private startedAt = 0;
  private readonly log: NonNullable<RunnerOptions['log']>;
  private readonly queueName: string;
  private readonly attempts: number;

  constructor(private readonly opts: RunnerOptions, private readonly defs: JobDef[]) {
    this.log = opts.log ?? silent;
    this.queueName = opts.queueName ?? 'freebie-radar-jobs';
    this.attempts = opts.attempts ?? 3;
  }

  private connect(): IORedis {
    // BullMQ workers require maxRetriesPerRequest: null so a Redis outage pauses work instead of failing jobs.
    const c = new IORedis(this.opts.redisUrl, { maxRetriesPerRequest: null });
    c.on('error', (e) => this.log.error(`Redis connection error: ${e.message}`));
    this.conns.push(c);
    return c;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.queue = new Queue(this.queueName, {
      connection: this.connect(),
      defaultJobOptions: {
        attempts: this.attempts,
        backoff: { type: 'exponential', delay: this.opts.backoffMs ?? 30_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
    await this.queue.setGlobalConcurrency(1);

    // Same id every start => same schedule, updated in place. Schedules for jobs that no longer exist are removed.
    const wanted = new Set(this.defs.map((d) => `sched:${d.name}`));
    for (const s of await this.queue.getJobSchedulers(0, 100)) if (s.key && !wanted.has(s.key)) await this.queue.removeJobScheduler(s.key);
    for (const d of this.defs) {
      await this.queue.upsertJobScheduler(`sched:${d.name}`, { every: d.everyMs }, { name: d.name, data: { scheduled: true } });
    }

    this.worker = new Worker(this.queueName, (job) => this.process(job), {
      connection: this.connect(),
      concurrency: 1,
      lockDuration: this.opts.lockDurationMs ?? 60_000,
      stalledInterval: this.opts.stalledIntervalMs ?? 30_000,
    });
    this.worker.on('error', (e) => this.log.error(`Worker error: ${e.message}`));
    this.worker.on('stalled', (id) => this.log.warn(`Job ${id} stalled (its worker stopped responding); it will be retried`));
    this.worker.on('completed', (job) => this.log.info(`Job ${job.name} done`));
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? this.attempts);
      this.log.error(`Job ${job.name} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? this.attempts})${final ? ', giving up until the next scheduled run' : ''}: ${err.message}`);
      if (final && this.opts.onFailure) void Promise.resolve(this.opts.onFailure({ name: job.name, attempts: job.attemptsMade, reason: err.message })).catch((e) => this.log.error(`onFailure hook failed: ${(e as Error).message}`));
    });
    await this.worker.waitUntilReady();
  }

  private async process(job: Job): Promise<unknown> {
    const def = this.defs.find((d) => d.name === job.name);
    if (!def) throw new Error(`No handler for job "${job.name}"`);
    const timeout = this.opts.runTimeoutMs ?? 5 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        def.run(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`Timed out after ${Math.round(timeout / 1000)}s`)), timeout); timer.unref(); }),
      ]);
      return result ?? null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Queues one extra run now. Repeated requests within the same minute collapse into one. */
  async runNow(name: string): Promise<{ queued: boolean; jobId: string }> {
    if (!this.defs.some((d) => d.name === name)) throw new Error(`Unknown job "${name}"`);
    const jobId = `manual:${name}:${Math.floor(Date.now() / 60_000)}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) return { queued: false, jobId };
    await this.queue.add(name, { manual: true }, { jobId });
    return { queued: true, jobId };
  }

  async status(): Promise<JobStatus[]> {
    const schedulers = await this.queue.getJobSchedulers(0, 100);
    const done = await this.queue.getJobs(['completed'], 0, 300, false);
    const failed = await this.queue.getJobs(['failed'], 0, 300, false);
    const now = Date.now();
    return this.defs.map((d) => {
      const s = schedulers.find((x) => x.key === `sched:${d.name}`);
      const ok = done.filter((j) => j.name === d.name && j.finishedOn).sort((a, b) => b.finishedOn! - a.finishedOn!)[0];
      const bad = failed.filter((j) => j.name === d.name && j.finishedOn).sort((a, b) => b.finishedOn! - a.finishedOn!)[0];
      const lastOkAt = ok?.finishedOn ?? null;
      return {
        name: d.name,
        everyMs: d.everyMs,
        nextRunAt: s?.next ? new Date(s.next).toISOString() : null,
        lastSuccess: ok ? { at: new Date(ok.finishedOn!).toISOString(), result: ok.returnvalue ?? null } : null,
        lastFailure: bad ? { at: new Date(bad.finishedOn!).toISOString(), reason: bad.failedReason ?? 'unknown', attempts: bad.attemptsMade } : null,
        stale: lastOkAt ? now - lastOkAt > 3 * d.everyMs + 120_000 : now - this.startedAt > 3 * d.everyMs + 120_000,
      };
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    for (const c of this.conns) c.disconnect();
    this.conns = [];
  }

  /** Test helper: stops without letting the running job finish or release its lock, like a crashed process. */
  async crash(): Promise<void> {
    await this.worker?.close(true).catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    for (const c of this.conns) c.disconnect();
    this.conns = [];
  }
}
