// Runs the Redis-backed job tests against the local docker Redis (port 6381 by default).
// Usage: npm run test:redis        (or REDIS_TEST_URL=redis://host:port npm run test:redis)
const { spawnSync } = require('child_process');
const url = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6381';
console.log(`Running job tests against ${url}`);
const r = spawnSync('npx', ['jest', 'src/jobs', 'test/jobs.e2e', '--runInBand', '--verbose'], { stdio: 'inherit', shell: true, env: { ...process.env, REDIS_TEST_URL: url } });
process.exit(r.status ?? 1);
