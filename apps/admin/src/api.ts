const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';
let token: string | null = sessionStorage.getItem('fr_admin_token');
export const setToken = (t: string | null) => { token = t; t ? sessionStorage.setItem('fr_admin_token', t) : sessionStorage.removeItem('fr_admin_token'); };
export const hasToken = () => !!token;
let refreshToken: string | null = sessionStorage.getItem('fr_admin_refresh');
export const setRefreshToken = (t: string | null) => { refreshToken = t; t ? sessionStorage.setItem('fr_admin_refresh', t) : sessionStorage.removeItem('fr_admin_refresh'); };

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Ends this browser's session on the server (best effort), then forgets both tokens. */
export async function signOut() {
  const rt = refreshToken;
  setToken(null); setRefreshToken(null);
  if (rt) await request('/auth/logout', { body: { refreshToken: rt } }).catch(() => undefined);
}

let renewing: Promise<boolean> | null = null;
/** Access tokens last 15 minutes; swap the single-use refresh token for a new pair and carry on. Parallel calls share one attempt. */
function renew(): Promise<boolean> {
  if (renewing) return renewing;
  renewing = (async () => {
    if (!refreshToken) return false;
    try {
      const r = await request<{ accessToken: string; refreshToken: string }>('/auth/refresh', { body: { refreshToken } });
      setToken(r.accessToken); setRefreshToken(r.refreshToken);
      return true;
    } catch { return false; }
  })().finally(() => { renewing = null; });
  return renewing;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await request<T>(path, opts);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && token && !path.startsWith('/auth/') && (await renew())) return request<T>(path, opts);
    throw e;
  }
}

async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch { throw new ApiError(0, 'Cannot reach the API. Check that it is running and that CORS_ORIGINS includes this site.'); }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, Array.isArray(json?.message) ? json.message.join('. ') : json?.message ?? `Request failed (${res.status})`);
  return json as T;
}

export interface Stats { users: number; listingsByStatus: Record<string, number>; listingsBySource: Record<string, number>; listingsByCountry: Record<string, number>; duplicateListings: number; openReports: number; deliveriesByStatus: Record<string, number> }
export interface ReportRow { report: { id: string; listingId: string; reason: string; details: string | null; evidenceUrl: string | null; status: string; createdAt: string }; listing: null | { id: string; title: string; status: string; riskLevel: string; riskSignals: string[]; sellerUserId: string | null } }
export interface Appeal { id: string; moderationId: string; userId: string; message: string; status: string; createdAt: string }
export interface AuditRow { id: string; actorId: string | null; action: string; entityType: string; entityId: string | null; metadata: Record<string, unknown>; createdAt: string }
export interface Me { id: string; email: string; displayName: string; role: 'USER' | 'BUSINESS' | 'MODERATOR' | 'ADMIN' }
