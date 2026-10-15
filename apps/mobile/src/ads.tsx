import Constants from 'expo-constants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { useAuth } from './auth';
import { Text } from './components/Text';
import { colors, space, type } from './theme';

/**
 * Ads (Google AdMob). Rules this file enforces:
 *  - Off unless EXPO_PUBLIC_ADS_ENABLED=true, so a build never shows ads by accident.
 *  - Never for Premium accounts.
 *  - Never before consent is settled: Google's consent form (UMP) runs first where the law requires it (UK/EEA, some US states).
 *  - Only the placements listed in Placement exist. There is deliberately no way to put an ad on sign-in, alerts, messages,
 *    payments, listing detail or posting screens: safety-critical places stay free of anything that could be mistaken for content.
 *  - The native module is absent in Expo Go; everything degrades to "no ad" there instead of crashing.
 *  - Without your own unit ids it serves Google's TEST ads (the release check refuses to build a store release that way).
 */
export type Placement = 'home' | 'search';

const ENABLED = process.env.EXPO_PUBLIC_ADS_ENABLED === 'true';
const inExpoGo = Constants.appOwnership === 'expo' || (Constants as any).executionEnvironment === 'storeClient';

type Lib = typeof import('react-native-google-mobile-ads');
let lib: Lib | null | undefined;
function native(): Lib | null {
  // Never even load the library when ads are off or we are in Expo Go: merely requiring it runs native-module
  // lookups at import time, which log errors (and can red-screen) where the native module does not exist.
  if (!ENABLED || inExpoGo) return null;
  if (lib !== undefined) return lib;
  try { lib = require('react-native-google-mobile-ads') as Lib; } catch { lib = null; }
  return lib;
}


interface AdsState { ready: boolean; privacyChoices: boolean; showPrivacyChoices: () => Promise<void> }
const Ctx = createContext<AdsState>({ ready: false, privacyChoices: false, showPrivacyChoices: async () => undefined });
export const useAds = () => useContext(Ctx);

export function AdsProvider({ children }: { children: React.ReactNode }) {
  const { user, ready: authReady } = useAuth();
  const [ready, setReady] = useState(false);
  const [privacyChoices, setPrivacyChoices] = useState(false);
  const wanted = ENABLED && !inExpoGo && authReady && (!user || user.tier === 'FREE');

  useEffect(() => {
    if (!wanted) { setReady(false); return; }
    const l = native();
    if (!l) return;
    let cancelled = false;
    (async () => {
      try {
        await l.default().setRequestConfiguration({ maxAdContentRating: l.MaxAdContentRating.PG, tagForChildDirectedTreatment: false, tagForUnderAgeOfConsent: false });
        const info = await l.AdsConsent.gatherConsent();
        if (cancelled) return;
        setPrivacyChoices(info.privacyOptionsRequirementStatus === l.AdsConsentPrivacyOptionsRequirementStatus.REQUIRED);
        if (!info.canRequestAds) return; // the person declined or consent is still pending: show nothing
        await l.default().initialize();
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) setReady(false); // any failure means no ads, never a crash
      }
    })();
    return () => { cancelled = true; };
  }, [wanted]);

  const showPrivacyChoices = useCallback(async () => { try { await native()?.AdsConsent.showPrivacyOptionsForm(); } catch { /* nothing to show */ } }, []);
  const value = useMemo(() => ({ ready: wanted && ready, privacyChoices: wanted && privacyChoices, showPrivacyChoices }), [wanted, ready, privacyChoices, showPrivacyChoices]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function unitId(l: Lib): string {
  const own = Platform.OS === 'ios' ? process.env.EXPO_PUBLIC_ADMOB_BANNER_IOS : process.env.EXPO_PUBLIC_ADMOB_BANNER_ANDROID;
  return own || l.TestIds.ADAPTIVE_BANNER;
}

/** A labelled banner, or nothing. It never leaves an empty gap: if the ad fails to load the whole slot disappears. */
export function AdSlot({ placement }: { placement: Placement }) {
  const { ready } = useAds();
  const [failed, setFailed] = useState(false);
  if (!ready || failed) return null;
  const l = native();
  if (!l) return null;
  const { BannerAd, BannerAdSize } = l;
  return (
    <View accessibilityLabel="Advertisement" testID={`ad-${placement}`} style={{ marginHorizontal: space.lg, marginVertical: space.md, gap: 4 }}>
      <Text style={[type.small, { color: colors.muted }]}>Advertisement</Text>
      <View style={{ alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: colors.line }}>
        <BannerAd unitId={unitId(l)} size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER} onAdFailedToLoad={() => setFailed(true)} />
      </View>
    </View>
  );
}
