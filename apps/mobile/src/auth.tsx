import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, setTokenGetter, UserView } from './api';

const KEY = 'fr_token';
interface AuthState {
  user: UserView | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string, countryCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => { const v = useContext(Ctx); if (!v) throw new Error('AuthProvider missing'); return v; };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const token = useRef<string | null>(null);
  const [user, setUser] = useState<UserView | null>(null);
  const [ready, setReady] = useState(false);
  setTokenGetter(() => token.current);

  const refresh = useCallback(async () => {
    if (!token.current) { setUser(null); return; }
    try { setUser(await api<UserView>('/me')); }
    catch (e) {
      // An expired or revoked token signs the user out; a network error keeps the session.
      if (e instanceof ApiError && e.status === 401) { token.current = null; await SecureStore.deleteItemAsync(KEY); setUser(null); }
    }
  }, []);

  useEffect(() => {
    (async () => {
      try { token.current = await SecureStore.getItemAsync(KEY); } catch { token.current = null; }
      await refresh();
      setReady(true);
    })();
  }, [refresh]);

  const accept = async (r: { accessToken: string; user: UserView }) => {
    token.current = r.accessToken;
    await SecureStore.setItemAsync(KEY, r.accessToken);
    setUser(r.user);
  };

  const value = useMemo<AuthState>(() => ({
    user, ready, refresh,
    login: async (email, password) => accept(await api('/auth/login', { body: { email, password } })),
    register: async (email, password, displayName, countryCode) => accept(await api('/auth/register', { body: { email, password, displayName, ...(countryCode ? { countryCode } : {}) } })),
    logout: async () => { token.current = null; await SecureStore.deleteItemAsync(KEY); setUser(null); },
  }), [user, ready, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
