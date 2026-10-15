// Loads apps/api/.env into process.env for local runs. Must be imported before anything reads configuration.
// Existing environment variables always win, tests never read the file, and a missing file is fine
// (production sets real environment variables).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env.NODE_ENV !== 'test') {
  const file = resolve(process.cwd(), '.env');
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader === 'function' && existsSync(file)) loader.call(process, file);
}
