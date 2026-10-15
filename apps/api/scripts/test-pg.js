// Runs the HTTP end-to-end suite against a real PostgreSQL database (Windows, macOS and Linux).
//
//   npm run test:pg
//
// Uses TEST_DATABASE_URL if set, otherwise postgresql://postgres:postgres@127.0.0.1:5432/freebie_radar_test.
// The database name MUST end in _test: the suite empties every table before it runs.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/freebie_radar_test';
const dbName = url.split('?')[0].split('/').pop();
if (!dbName.endsWith('_test')) {
  console.error(`Refusing to run: database "${dbName}" does not end in _test (the suite truncates all tables).`);
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: true }).status ?? 1;

async function ensureDatabase() {
  const { PrismaClient } = require('@prisma/client');
  const adminUrl = url.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    const rows = await admin.$queryRawUnsafe(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`);
    if (rows.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }
}

(async () => {
  await ensureDatabase();
  if (run('npx', ['prisma', 'migrate', 'deploy']) !== 0) process.exit(1);
  process.exit(run('npx', ['jest', 'test/api.e2e.spec.ts', '--runInBand']));
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
