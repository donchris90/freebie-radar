import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ListingView } from './api';
import { useAuth } from './auth';

interface SavedState { ids: Set<string>; toggle: (id: string) => Promise<boolean>; reload: () => Promise<void> }
const Ctx = createContext<SavedState | null>(null);
export const useSaved = () => { const v = useContext(Ctx); if (!v) throw new Error('SavedProvider missing'); return v; };

export function SavedProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [ids, setIds] = useState<Set<string>>(new Set());
  const reload = useCallback(async () => {
    if (!user) { setIds(new Set()); return; }
    try { setIds(new Set((await api<{ items: ListingView[] }>('/saved')).items.map((i) => i.id))); } catch { /* keep previous */ }
  }, [user]);
  useEffect(() => { void reload(); }, [reload]);

  const toggle = useCallback(async (id: string) => {
    const was = ids.has(id);
    setIds((s) => { const n = new Set(s); was ? n.delete(id) : n.add(id); return n; }); // optimistic
    try {
      await api(`/saved/${id}`, { method: was ? 'DELETE' : 'POST' });
      return !was;
    } catch (e) {
      setIds((s) => { const n = new Set(s); was ? n.add(id) : n.delete(id); return n; }); // roll back
      throw e;
    }
  }, [ids]);

  const value = useMemo(() => ({ ids, toggle, reload }), [ids, toggle, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
