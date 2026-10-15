import { resolve } from 'path';
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
  /** Where uploaded photos live. `local` (disk) for development; `s3` for production. */
  storageDriver: 'local' | 's3';
  uploadDir: string;
  /** Public origin used in photo URLs for the local driver. Falls back to the request's own origin. */
  publicBaseUrl: string | null;
  /** Refresh tokens last this long; each use rotates them. */
  refreshTtlDays: number;
  /** A refresh token reused within this many seconds of being used counts as a race, not theft. */
  refreshReuseGraceSeconds: number;
  /** Minimum gap between emailed codes for one account and purpose. */
  codeResendSeconds: number;
  /** Email delivery. `log` prints messages to the console and is refused in production. */
  mail: { driver: 'log' | 'smtp'; from: string; smtpUrl: string | null };
  /** When true, only accounts with a verified email can post listings. Defaults to on in production. */
  requireVerifiedEmail: boolean;
  s3: null | { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string; endpoint: string | null };
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
  const driver = (env.STORAGE_DRIVER ?? 'local').toLowerCase();
  if (driver !== 'local' && driver !== 's3') throw new Error('STORAGE_DRIVER must be "local" or "s3"');
  let s3: AppConfig['s3'] = null;
  if (driver === 's3') {
    const need = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_BASE_URL'];
    const missing = need.filter((k) => !env[k]);
    if (missing.length) throw new Error(`STORAGE_DRIVER=s3 requires ${missing.join(', ')}`);
    s3 = { bucket: env.S3_BUCKET!, region: env.S3_REGION!, accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY!, publicBaseUrl: env.S3_PUBLIC_BASE_URL!, endpoint: env.S3_ENDPOINT || null };
  }
  if (nodeEnv === 'production' && driver === 'local' && !env.PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is required in production when STORAGE_DRIVER=local (and local disk must be persistent)');
  }
  const mailDriver = (env.MAIL_DRIVER ?? (env.SMTP_URL ? 'smtp' : 'log')).toLowerCase();
  if (mailDriver !== 'log' && mailDriver !== 'smtp') throw new Error('MAIL_DRIVER must be "log" or "smtp"');
  if (mailDriver === 'smtp' && !env.SMTP_URL) throw new Error('MAIL_DRIVER=smtp requires SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465)');
  if (nodeEnv === 'production' && mailDriver !== 'smtp') {
    throw new Error('Production needs real email delivery: set SMTP_URL and MAIL_FROM (password reset and verification depend on it)');
  }
  if (nodeEnv === 'production' && !env.MAIL_FROM) throw new Error('MAIL_FROM is required in production');
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
    storageDriver: driver,
    uploadDir: env.UPLOAD_DIR ?? resolve(process.cwd(), 'uploads'),
    publicBaseUrl: env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/$/, '') : null,
    refreshTtlDays: int(env.REFRESH_TTL_DAYS, 30),
    refreshReuseGraceSeconds: int(env.REFRESH_REUSE_GRACE_SECONDS, 10),
    codeResendSeconds: int(env.CODE_RESEND_SECONDS, 60),
    mail: { driver: mailDriver, from: env.MAIL_FROM ?? 'Freebie Radar <no-reply@localhost>', smtpUrl: env.SMTP_URL ?? null },
    requireVerifiedEmail: env.REQUIRE_VERIFIED_EMAIL ? env.REQUIRE_VERIFIED_EMAIL === 'true' : nodeEnv === 'production',
    s3,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
