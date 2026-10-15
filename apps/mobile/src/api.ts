import Constants from 'expo-constants';

// Development falls back to localhost (works on the simulator and with `adb reverse`); a release build never
// does, because on a real phone localhost is the phone itself. Misconfiguration surfaces as a clear error instead
// of a silent "can't reach" screen.
const fromExtra = Constants.expoConfig?.extra?.apiUrl;
const CONFIGURED: string | null = process.env.EXPO_PUBLIC_API_URL || (typeof fromExtra === 'string' && fromExtra ? fromExtra : null);
export const API_CONFIG_ERROR: string | null = CONFIGURED
  ? (!__DEV__ && !CONFIGURED.startsWith('https://') ? 'This build is configured with a non-HTTPS API address.' : null)
  : (__DEV__ ? null : 'This build has no API address configured.');
const BASE: string = CONFIGURED ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(public status: number, message: string, public offline = false) {
    super(message);
  }
}

let getToken: () => string | null = () => null;
export const setTokenGetter = (fn: () => string | null) => { getToken = fn; };
/** Called once when a request comes back 401 with a token attached; resolves true if a new session was obtained. */
let refresher: (() => Promise<boolean>) | null = null;
export const setRefresher = (fn: () => Promise<boolean>) => { refresher = fn; };

type Query = Record<string, string | number | boolean | undefined | null>;

export async function api<T>(path: string, opts: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  const sentToken = getToken();
  try {
    return await request<T>(path, opts);
  } catch (e) {
    // An expired access token is routine: swap the refresh token for a new pair and retry once.
    // Auth endpoints are excluded so a wrong password or a dead refresh token never loops.
    if (e instanceof ApiError && e.status === 401 && sentToken && refresher && !path.startsWith('/auth/') && (await refresher())) return request<T>(path, opts);
    throw e;
  }
}

async function request<T>(path: string, opts: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  if (API_CONFIG_ERROR) throw new ApiError(0, `${API_CONFIG_ERROR} Reinstall the latest version of the app.`, false);
  const qs = opts.query
    ? '?' + Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  const token = getToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${qs === '?' ? '' : qs}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, "Can't reach Freebie Radar. Check your connection and try again.", true);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const m = (json as { message?: string | string[] } | null)?.message;
    throw new ApiError(res.status, Array.isArray(m) ? m.join('. ') : m ?? `Request failed (${res.status})`);
  }
  return json as T;
}

/** Uploads one photo from a local file URI (camera or library) and returns its public URL. */
export async function uploadPhoto(uri: string, mimeType?: string | null): Promise<string> {
  const token = getToken();
  const form = new FormData();
  // React Native's FormData accepts a { uri, name, type } descriptor for files.
  form.append('file', { uri, name: 'photo.jpg', type: mimeType ?? 'image/jpeg' } as unknown as Blob);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  let res: Response;
  try {
    res = await fetch(`${BASE}/uploads/images`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: form, signal: ctrl.signal });
  } catch {
    throw new ApiError(0, "Can't upload right now. Check your connection and try again.", true);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: { url?: string; message?: string | string[] } | null = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok || !json?.url) {
    const m = json?.message;
    throw new ApiError(res.status, Array.isArray(m) ? m.join('. ') : m ?? `Upload failed (${res.status})`);
  }
  return json.url;
}

export interface ListingView {
  id: string;
  title: string;
  description: string;
  category: string;
  condition: string;
  price: { minor: number | null; currency: string; label: string; isFree: boolean };
  location: { lat: number; lng: number; label: string | null; precision: 'approximate' };
  distance: { km: number; label: string } | null;
  source: { key: string; name: string; verified: boolean; attribution?: { text: string | null; url: string | null } | null };
  freshness: { label: string; ageHours: number; stale: boolean };
  status: string;
  risk: { level: 'NO_MAJOR_SIGNALS' | 'EXERCISE_CAUTION' | 'UNDER_REVIEW'; label: string; signals: string[] };
  dealScore: null | {
    score: number;
    explanation: string;
    evidence: { sampleSize: number; median: string | null; range: string | null; limitations: string[] };
  };
  dealScoreNote?: string;
  sponsored: boolean;
  images: string[];
  externalUrl: string | null;
  contactMethod: string;
  safetyGuidance?: string[];
  isOwner?: boolean;
  messageable: boolean;
}
export interface Page<T> { items: T[]; total: number; nextCursor: string | null }

export interface UserView {
  id: string; email: string; displayName: string; role: string; tier: string; countryCode: string; timeZone: string;
  emailVerified: boolean;
  prefs: { distanceUnit: 'mi' | 'km'; homeLat: number | null; homeLng: number | null; homeLabel: string | null; personalisationEnabled: boolean; pushEnabled: boolean; pushTokenSet: boolean; maxPushPerDay: number };
}

export interface AlertView {
  id: string; name: string; keywords: string[]; excludedWords: string[]; categories: string[]; maxPriceMinor: number | null; minPriceMinor: number | null;
  currency: string | null; freeOnly: boolean; radiusKm: number | null; minDealScore: number | null; frequency: string; active: boolean;
}

export const CATEGORIES = ['furniture', 'electronics', 'household', 'clothing', 'baby', 'tools', 'books', 'toys', 'sports', 'garden', 'other'];
export const CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR', 'FOR_PARTS'];
export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export interface ConversationSummary {
  id: string; role: 'BUYER' | 'SELLER';
  listing: { id: string; title: string; status: string; image: string | null };
  other: { displayName: string };
  lastMessage: { preview: string; at: string; mine: boolean } | null;
  unread: boolean; canReply: boolean; closedReason: string | null; closedMessage: string | null;
}
export interface ChatMessage { id: string; mine: boolean; body: string; at: string; caution?: string }
