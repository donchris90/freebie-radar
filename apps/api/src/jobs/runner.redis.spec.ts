import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { FailureInfo, JobDef, JobRunner } from './runner';

/**
 * These tests need a real Redis. Set REDIS_TEST_URL (for example redis://127.0.0.1:6381) to run them;
 * without it they are skipped, and the skip is visible in the jest summary.
 */
const URL = process.env.REDIS_TEST_URL;
const d = URL ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(step); }
  return false;
}
let n = 0;
const qname = () => `test-jobs-${process.pid}-${Date.now()}-${++n}`;

d('JobRunner on Redis', () => {
  const opened: JobRunner[] = [];
  const queues: string[] = [];
  const mk = (queueName: string, defs: JobDef[], extra: Partial<ConstructorParameters<typeof JobRunner>[0]> = {}) => {
    const r = new JobRunner({ redisUrl: URL!, queueName, backoffMs: 50, ...extra }, defs);
    opened.push(r);
    return r;
  };
  afterEach(async () => {
    for (const r of opened.splice(0)) await r.stop();
    const c = new IORedis(URL!, { maxRetriesPerRequest: null });
    for (const q of queues.splice(0)) { const queue = new Queue(q, { connection: c }); await queue.obliterate({ force: true }).catch(() => undefined); await queue.close(); }
    c.disconnect();
  });

  it('runs a job repeatedly on its own and reports the result', async () => {
    const q = qname(); queues.push(q);
    let runs = 0;
    const r = mk(q, [{ name: 'tick', everyMs: 150, run: async () => ({ runs: ++runs }) }]);
    await r.start();
    expect(await until(() => runs >= 3)).toBe(true);
    const [s] = await r.status();
    expect(s.name).toBe('tick');
    expect(s.lastSuccess?.result).toMatchObject({ runs: expect.any(Number) });
    expect(s.stale).toBe(false);
    expect(s.nextRunAt).toBeTruthy();
  });

  it('keeps one schedule and never overlaps runs, even with two instances on the same queue', async () => {
    const q = qname(); queues.push(q);
    let active = 0; let maxActive = 0; let runs = 0;
    const def: JobDef = { name: 'slow', everyMs: 100, run: async () => { active++; maxActive = Math.max(maxActive, active); await sleep(120); runs++; active--; } };
    const a = mk(q, [def]); const b = mk(q, [def]);
    await Promise.all([a.start(), b.start()]);
    expect(await until(() => runs >= 4, 10000)).toBe(true);
    expect(maxActive).toBe(1);
    const c = new IORedis(URL!, { maxRetriesPerRequest: null });
    const probe = new Queue(q, { connection: c });
    expect((await probe.getJobSchedulers()).length).toBe(1);
    await probe.close(); c.disconnect();
  });

  it('retries a failing run with backoff and succeeds without reporting a failure', async () => {
    const q = qname(); queues.push(q);
    let calls = 0; const failures: FailureInfo[] = [];
    const r = mk(q, [{ name: 'flaky', everyMs: 3_600_000, run: async () => { if (++calls < 3) throw new Error('upstream hiccup'); return { ok: true }; } }], { attempts: 3, onFailure: (f) => { failures.push(f); } });
    await r.start(); // the schedule's first run starts straight away
    expect(await until(() => calls >= 3)).toBe(true);
    expect(await until(async () => (await r.status())[0].lastSuccess !== null)).toBe(true);
    expect(failures).toHaveLength(0);
  });

  it('reports a run that fails every attempt, once, with the reason', async () => {
    const q = qname(); queues.push(q);
    let calls = 0; const failures: FailureInfo[] = [];
    const r = mk(q, [{ name: 'broken', everyMs: 3_600_000, run: async () => { calls++; throw new Error('database unreachable'); } }], { attempts: 2, onFailure: (f) => { failures.push(f); } });
    await r.start();
    expect(await until(() => failures.length >= 1)).toBe(true);
    await sleep(300);
    expect(calls).toBe(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: 'broken', attempts: 2, reason: 'database unreachable' });
    expect(await until(async () => (await r.status())[0].lastFailure !== null)).toBe(true);
    expect((await r.status())[0].lastFailure?.reason).toBe('database unreachable');
  });

  it('collapses repeated manual requests within a minute into one run', async () => {
    const q = qname(); queues.push(q);
    let runs = 0;
    const r = mk(q, [{ name: 'once', everyMs: 3_600_000, run: async () => { runs++; } }]);
    await r.start();
    const first = await r.runNow('once');
    const second = await r.runNow('once');
    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    await expect(r.runNow('nope')).rejects.toThrow(/Unknown job/);
    expect(await until(() => runs >= 1)).toBe(true);
  });

  it('keeps its schedule while no process is running, and picks work up again after a restart', async () => {
    const q = qname(); queues.push(q);
    let runs = 0;
    const def: JobDef = { name: 'persist', everyMs: 200, run: async () => { runs++; } };
    const first = mk(q, [def]);
    await first.start();
    expect(await until(() => runs >= 1)).toBe(true);
    await first.stop();
    const before = runs;
    const c = new IORedis(URL!, { maxRetriesPerRequest: null });
    const probe = new Queue(q, { connection: c });
    expect((await probe.getJobSchedulers()).map((s) => s.key)).toEqual(['sched:persist']); // survives with nobody running
    await probe.close(); c.disconnect();
    await sleep(500);
    expect(runs).toBe(before); // nothing runs while the app is down...
    const second = mk(q, [def]);
    await second.start();
    expect(await until(() => runs > before)).toBe(true); // ...and it resumes on the next start
  });

  it('recovers a run that was in progress when its process died', async () => {
    const q = qname(); queues.push(q);
    let hung = 0; let recovered = 0;
    const opts = { lockDurationMs: 600, stalledIntervalMs: 300 };
    const a = mk(q, [{ name: 'job', everyMs: 3_600_000, run: () => { hung++; return new Promise<void>(() => undefined); } }], opts);
    await a.start();
    await a.runNow('job');
    expect(await until(() => hung === 1)).toBe(true);
    await a.crash(); // dies without finishing or releasing the lock
    const b = mk(q, [{ name: 'job', everyMs: 3_600_000, run: async () => { recovered++; } }], opts);
    await b.start();
    expect(await until(() => recovered >= 1, 10000)).toBe(true);
    expect(hung).toBe(1);
  });
});
