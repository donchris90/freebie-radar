import { DEFAULT_LAUNCH_COUNTRIES } from '../core/countries';

/** Runtime configuration. Market, currency, countries and limits come from the environment, not code. */

export const DEFAULT_CATEGORIES = [
  'furniture',
  'electronics',
  'household',
  'clothing',
  'baby',
  'tools',
  'books',
  'toys',
  'sports',
  'garden',
  'other',
];

export interface AppConfig {
  nodeEnv: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  bcryptCost: number;
  defaultCountry: string;
  defaultCurrency: string;
  /** Countries switched on the first time the catalog loads. After that the admin dashboard decides. */
  launchCountries: string[];
  categories: string[];
  throttleLimit: number;
  /** Max saved alerts by tier. Values are configuration, not pricing decisions. */
  alertLimits: Record<'FREE' | 'PREMIUM' | 'BUSINESS', number>;
  reportThreshold: number;
  /** Persistence adapter. Production always uses the database; the in-memory store refuses to start there. */
  store: 'memory' | 'prisma';
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const secret = env.JWT_SECRET ?? '';
  if (nodeEnv === 'production' && (secret.length < 32 || secret.startsWith('change-me'))) {
    throw new Error('JWT_SECRET must be set to a long random value in production');
  }
  const storeRaw = (env.STORE ?? (nodeEnv === 'production' ? 'prisma' : 'memory')).toLowerCase();
  if (storeRaw !== 'memory' && storeRaw !== 'prisma') throw new Error('STORE must be "memory" or "prisma"');
  if (storeRaw === 'prisma' && !env.DATABASE_URL) throw new Error('DATABASE_URL is required when STORE=prisma');
  const list = (v: string | undefined, d: string[]) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);
  return {
    nodeEnv,
    jwtSecret: secret || 'dev-only-insecure-secret-do-not-use-in-production',
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '15m',
    bcryptCost: int(env.BCRYPT_COST, nodeEnv === 'test' ? 4 : 11),
    defaultCountry: (env.DEFAULT_COUNTRY ?? 'US').toUpperCase(),
    defaultCurrency: (env.DEFAULT_CURRENCY ?? 'USD').toUpperCase(),
    launchCountries: list(env.LAUNCH_COUNTRIES, DEFAULT_LAUNCH_COUNTRIES).map((c) => c.toUpperCase()),
    categories: list(env.CATEGORIES, DEFAULT_CATEGORIES),
    throttleLimit: int(env.THROTTLE_LIMIT, 120),
    alertLimits: { FREE: int(env.ALERT_LIMIT_FREE, 3), PREMIUM: int(env.ALERT_LIMIT_PREMIUM, 25), BUSINESS: int(env.ALERT_LIMIT_BUSINESS, 50) },
    reportThreshold: int(env.REPORT_THRESHOLD, 2),
    store: storeRaw,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
