import * as Location from 'expo-location';
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';

export interface Place { lat: number; lng: number; label: string }
interface LocationState {
  place: Place | null;
  permission: 'unknown' | 'granted' | 'denied';
  busy: boolean;
  error: string | null;
  useCurrent: () => Promise<void>;
  setManual: (query: string) => Promise<void>;
}
const Ctx = createContext<LocationState | null>(null);
export const useLocationState = () => { const v = useContext(Ctx); if (!v) throw new Error('LocationProvider missing'); return v; };

/** Location is requested only when the user asks (one-shot, balanced accuracy). There is no background tracking. */
export function LocationProvider({ children }: { children: React.ReactNode }) {
  const { user, refresh } = useAuth();
  const [chosen, setChosen] = useState<Place | null>(null);
  const [permission, setPermission] = useState<LocationState['permission']>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const home: Place | null = user?.prefs.homeLat != null && user?.prefs.homeLng != null
    ? { lat: user.prefs.homeLat, lng: user.prefs.homeLng, label: user.prefs.homeLabel ?? 'Saved location' } : null;
  const place = chosen ?? home;

  const remember = useCallback(async (p: Place) => {
    setChosen(p);
    if (user) {
      try { await api('/me/preferences', { method: 'PATCH', body: { homeLat: p.lat, homeLng: p.lng, homeLabel: p.label } }); await refresh(); } catch { /* local choice still applies */ }
    }
  }, [user, refresh]);

  const useCurrent = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') { setPermission('denied'); setError('Location permission is off. Choose a location manually instead.'); return; }
      setPermission('granted');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await remember({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Near me' });
    } catch { setError("Couldn't get your location. Try again or choose a location manually."); }
    finally { setBusy(false); }
  }, [remember]);

  const setManual = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await Location.geocodeAsync(query.trim());
      if (!r.length) { setError(`No match for "${query.trim()}". Try a city or postcode.`); return; }
      await remember({ lat: r[0].latitude, lng: r[0].longitude, label: query.trim() });
    } catch { setError("Couldn't look that place up. Check your connection and try again."); }
    finally { setBusy(false); }
  }, [remember]);

  const value = useMemo(() => ({ place, permission, busy, error, useCurrent, setManual }), [place, permission, busy, error, useCurrent, setManual]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
