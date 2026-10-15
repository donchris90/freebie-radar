import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, setRefresher, setTokenGetter, UserView } from './api';

const KEY = 'fr_token';
const REFRESH_KEY = 'fr_refresh';

interface Session { accessToken: string; refreshToken: string; user?: UserView }
interface AuthState {
  user: UserView | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string, countryCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
  /** Adopts a fresh token pair, e.g. after changing the password, so this device stays signed in. */
  adoptSession: (s: Session) => Promise<void>;
  refresh: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => { const v = useContext(Ctx); if (!v) throw new Error('AuthProvider missing'); return v; };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const token = useRef<string | null>(null);
  const refreshToken = useRef<string | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const [user, setUser] = useState<UserView | null>(null);
  const [ready, setReady] = useState(false);
  setTokenGetter(() => token.current);

  const clear = useCallback(async () => {
    token.current = null; refreshToken.current = null;
    await SecureStore.deleteItemAsync(KEY).catch(() => undefined);
    await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => undefined);
    setUser(null);
  }, []);

  const store = useCallback(async (s: Session) => {
    token.current = s.accessToken; refreshToken.current = s.refreshToken;
    await SecureStore.setItemAsync(KEY, s.accessToken);
    await SecureStore.setItemAsync(REFRESH_KEY, s.refreshToken);
    if (s.user) setUser(s.user);
  }, []);

  /** One refresh at a time: parallel requests that all hit 401 share the same attempt, because tokens are single-use. */
  const renew = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      const rt = refreshToken.current;
      if (!rt) return false;
      try {
        await store(await api<Session>('/auth/refresh', { body: { refreshToken: rt } }));
        return true;
      } catch (e) {
        // Rejected token: the session is over. A network error leaves the session alone so it can retry later.
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) await clear();
        return false;
      }
    })().finally(() => { inFlight.current = null; });
    inFlight.current = run;
    return run;
  }, [store, clear]);
  setRefresher(renew);

  const refresh = useCallback(async () => {
    if (!token.current) { setUser(null); return; }
    try { setUser(await api<UserView>('/me')); }
    catch (e) {
      // api() already tried to renew; a 401 that survives means the session is truly over.
      if (e instanceof ApiError && e.status === 401) await clear();
    }
  }, [clear]);

  useEffect(() => {
    (async () => {
      try {
        token.current = await SecureStore.getItemAsync(KEY);
        refreshToken.current = await SecureStore.getItemAsync(REFRESH_KEY);
      } catch { token.current = null; refreshToken.current = null; }
      await refresh();
      setReady(true);
    })();
  }, [refresh]);

  const value = useMemo<AuthState>(() => ({
    user, ready, refresh,
    login: async (email, password) => store(await api('/auth/login', { body: { email, password } })),
    register: async (email, password, displayName, countryCode) => store(await api('/auth/register', { body: { email, password, displayName, ...(countryCode ? { countryCode } : {}) } })),
    logout: async () => {
      const rt = refreshToken.current;
      await clear();
      if (rt) await api('/auth/logout', { body: { refreshToken: rt } }).catch(() => undefined); // best effort; the token is gone from this phone either way
    },
    logoutEverywhere: async () => {
      await api('/auth/logout-everywhere', { method: 'POST' });
      await clear();
    },
    adoptSession: async (s) => { await store(s); await refresh(); },
  }), [user, ready, refresh, store, clear]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
