const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';
let token: string | null = sessionStorage.getItem('fr_admin_token');
export const setToken = (t: string | null) => { token = t; t ? sessionStorage.setItem('fr_admin_token', t) : sessionStorage.removeItem('fr_admin_token'); };
export const hasToken = () => !!token;

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
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
