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
  enabledCountries: string[];
  categories: string[];
  throttleLimit: number;
  /** Max saved alerts by tier. Values are configuration, not pricing decisions. */
  alertLimits: Record<'FREE' | 'PREMIUM' | 'BUSINESS', number>;
  reportThreshold: number;
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const secret = env.JWT_SECRET ?? '';
  if (nodeEnv === 'production' && (secret.length < 32 || secret.startsWith('change-me'))) {
    throw new Error('JWT_SECRET must be set to a long random value in production');
  }
  const list = (v: string | undefined, d: string[]) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);
  return {
    nodeEnv,
    jwtSecret: secret || 'dev-only-insecure-secret-do-not-use-in-production',
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '15m',
    bcryptCost: int(env.BCRYPT_COST, nodeEnv === 'test' ? 4 : 11),
    defaultCountry: (env.DEFAULT_COUNTRY ?? 'US').toUpperCase(),
    defaultCurrency: (env.DEFAULT_CURRENCY ?? 'USD').toUpperCase(),
    enabledCountries: list(env.ENABLED_COUNTRIES, ['US', 'GB', 'CA', 'AU']).map((c) => c.toUpperCase()),
    categories: list(env.CATEGORIES, DEFAULT_CATEGORIES),
    throttleLimit: int(env.THROTTLE_LIMIT, 120),
    alertLimits: { FREE: int(env.ALERT_LIMIT_FREE, 3), PREMIUM: int(env.ALERT_LIMIT_PREMIUM, 25), BUSINESS: int(env.ALERT_LIMIT_BUSINESS, 50) },
    reportThreshold: int(env.REPORT_THRESHOLD, 2),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
