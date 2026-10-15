import { resolve } from 'path';
import { DEFAULT_LAUNCH_COUNTRIES } from '../core/countries';
import { parseMajorToMinor } from '../core/money';

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

export interface PartnerFeedConfig {
  key: string;
  name: string;
  url: string;
  apiKey: string | null;
  countries: string[];
  attribution: string;
  attributionUrl: string | null;
  permissionNote: string | null;
  expireAfterHours: number;
  retireAfterHours: number;
  rateLimitPerMinute: number | null;
}

export interface PlanConfig {
  key: string;
  tier: 'PREMIUM';
  interval: 'monthly' | 'annual';
  title: string;
  /** Price per currency, in minor units. */
  prices: Record<string, number>;
  /** The provider's own payment-plan id per currency (needed for recurring billing). */
  planCodes: Record<string, string>;
}

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
  /** Background jobs (listing expiry, alert dispatch, source sync) run on BullMQ when Redis is configured. */
  jobs: { enabled: boolean; redisUrl: string | null; queueName: string; /** Test hook: run every job at this interval instead of its own. */ intervalOverrideMs: number | null };
  /** Partner listing feeds (see docs/LISTING_SOURCES.md). Each one is read from PARTNER_FEED_<KEY>_* variables. */
  partnerFeeds: PartnerFeedConfig[];
  /** Paid plans. Billing is off until a provider is configured. */
  billing: {
    provider: 'flutterwave' | null;
    flutterwave: { secretKey: string | null; secretHash: string | null; baseUrl: string };
    plans: PlanConfig[];
    graceDays: number;
    /** Whether the iOS app may start web checkout. Off by default: see docs/BILLING.md on store rules. */
    allowIos: boolean;
  };
  /** Abuse limits for in-app messages. */
  messaging: { newConversationsPerDay: number; messagesPerHour: number; maxUnanswered: number; maxBodyChars: number };
  /** Sync tuning. */
  sync: { everyMs: number; pageSize: number; maxPages: number; maxRunMs: number };
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
  const redisUrl = env.REDIS_URL || null;
  const jobsEnabled = env.JOBS_ENABLED ? env.JOBS_ENABLED === 'true' : !!redisUrl && nodeEnv !== 'test';
  if (jobsEnabled && !redisUrl) throw new Error('JOBS_ENABLED=true requires REDIS_URL');
  if (nodeEnv === 'production' && !jobsEnabled && env.JOBS_ENABLED !== 'false') {
    throw new Error('Production needs Redis for scheduled jobs: set REDIS_URL (or JOBS_ENABLED=false if a separate process runs them)');
  }
  const feedKeys = (env.PARTNER_FEEDS ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const partnerFeeds = feedKeys.map((key): PartnerFeedConfig => {
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(key) || key === 'direct' || key === 'external-link') throw new Error(`PARTNER_FEEDS: "${key}" is not a valid source key`);
    const p = `PARTNER_FEED_${key.toUpperCase().replace(/-/g, '_')}_`;
    const url = env[`${p}URL`];
    if (!url) throw new Error(`${p}URL is required for partner feed "${key}"`);
    if (!/^https:\/\//i.test(url) && !(nodeEnv !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(url))) {
      throw new Error(`${p}URL must be an https URL`);
    }
    const attribution = env[`${p}ATTRIBUTION`];
    if (!attribution) throw new Error(`${p}ATTRIBUTION is required: say how listings from "${key}" must be credited`);
    return {
      key,
      name: env[`${p}NAME`] ?? key,
      url,
      apiKey: env[`${p}API_KEY`] ?? null,
      countries: (env[`${p}COUNTRIES`] ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean),
      attribution,
      attributionUrl: env[`${p}ATTRIBUTION_URL`] ?? null,
      permissionNote: env[`${p}PERMISSION_NOTE`] ?? null,
      expireAfterHours: int(env[`${p}EXPIRE_HOURS`], 48),
      retireAfterHours: int(env[`${p}RETIRE_HOURS`], 72),
      rateLimitPerMinute: env[`${p}RATE_LIMIT_PER_MINUTE`] ? int(env[`${p}RATE_LIMIT_PER_MINUTE`], 0) || null : null,
    };
  });
  const billingProvider = env.BILLING_PROVIDER ? env.BILLING_PROVIDER.toLowerCase() : null;
  if (billingProvider && billingProvider !== 'flutterwave') throw new Error(`BILLING_PROVIDER "${billingProvider}" is not implemented. Supported: flutterwave`);
  const flwKey = env.FLUTTERWAVE_SECRET_KEY || null;
  const flwHash = env.FLUTTERWAVE_SECRET_HASH || null;
  if (billingProvider === 'flutterwave') {
    if (!flwKey || !flwHash) throw new Error('BILLING_PROVIDER=flutterwave needs FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_SECRET_HASH');
    if (nodeEnv === 'production' && /TEST/i.test(flwKey)) throw new Error('Production must not use a Flutterwave test key');
    if (flwHash.length < 16) throw new Error('FLUTTERWAVE_SECRET_HASH must be a long random string (16+ characters)');
  }
  const pairs = (v: string | undefined) => Object.fromEntries((v ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf(':'); return [p.slice(0, i).trim().toUpperCase(), p.slice(i + 1).trim()]; }));
  const priceMinor = Object.fromEntries(Object.entries(pairs(env.PREMIUM_MONTHLY_PRICES)).map(([c, v]) => [c, parseMajorToMinor(v, c)]));
  const plans: PlanConfig[] = billingProvider && Object.keys(priceMinor).length
    ? [{ key: 'premium_monthly', tier: 'PREMIUM', interval: 'monthly', title: 'Premium', prices: priceMinor, planCodes: pairs(env.FLUTTERWAVE_PREMIUM_MONTHLY_PLAN_IDS) }]
    : [];
  if (billingProvider && plans.length) {
    const missing = Object.keys(priceMinor).filter((c) => !plans[0].planCodes[c]);
    if (missing.length) throw new Error(`FLUTTERWAVE_PREMIUM_MONTHLY_PLAN_IDS is missing a plan code for: ${missing.join(', ')}`);
  }
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
    jobs: { enabled: jobsEnabled, redisUrl, queueName: env.JOBS_QUEUE_NAME ?? 'freebie-radar-jobs', intervalOverrideMs: env.JOBS_INTERVAL_MS ? int(env.JOBS_INTERVAL_MS, 0) || null : null },
    partnerFeeds,
    billing: { provider: billingProvider as 'flutterwave' | null, flutterwave: { secretKey: flwKey, secretHash: flwHash, baseUrl: env.FLUTTERWAVE_BASE_URL ?? 'https://api.flutterwave.com' }, plans, graceDays: int(env.BILLING_GRACE_DAYS, 3), allowIos: env.BILLING_ALLOW_IOS === 'true' },
    messaging: { newConversationsPerDay: int(env.MSG_NEW_CONVERSATIONS_PER_DAY, 10), messagesPerHour: int(env.MSG_PER_HOUR, 30), maxUnanswered: int(env.MSG_MAX_UNANSWERED, 5), maxBodyChars: int(env.MSG_MAX_CHARS, 1000) },
    sync: { everyMs: int(env.SYNC_INTERVAL_MINUTES, 60) * 60_000, pageSize: int(env.SYNC_PAGE_SIZE, 100), maxPages: int(env.SYNC_MAX_PAGES, 50), maxRunMs: int(env.SYNC_MAX_RUN_SECONDS, 240) * 1000 },
    refreshTtlDays: int(env.REFRESH_TTL_DAYS, 30),
    refreshReuseGraceSeconds: int(env.REFRESH_REUSE_GRACE_SECONDS, 10),
    codeResendSeconds: int(env.CODE_RESEND_SECONDS, 60),
    mail: { driver: mailDriver, from: env.MAIL_FROM ?? 'Freebie Radar <no-reply@localhost>', smtpUrl: env.SMTP_URL ?? null },
    requireVerifiedEmail: env.REQUIRE_VERIFIED_EMAIL ? env.REQUIRE_VERIFIED_EMAIL === 'true' : nodeEnv === 'production',
    s3,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
