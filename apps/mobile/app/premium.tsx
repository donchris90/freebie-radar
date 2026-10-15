import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Platform, ScrollView, View } from 'react-native';
import { api, ApiError } from '../src/api';
import { useAuth } from '../src/auth';
import { Text } from '../src/components/Text';
import { Button, ErrorState, LoadingState, Panel } from '../src/components/ui';
import { colors, space, type } from '../src/theme';
import { useAsync } from '../src/useAsync';

interface Plans { available: boolean; checkoutAllowed: boolean; reason: string | null; currentTier: string; plans: { key: string; title: string; interval: string; benefits: string[]; prices: { currency: string; label: string }[]; defaultCurrency: string | null }[] }
interface Status { tier: string; subscription: null | { status: string; planKey: string | null; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null; active: boolean }; payments: { reference: string; status: string; amount: string; createdAt: string }[] }

export default function Premium() {
  const { user, ready, refresh } = useAuth();
  const router = useRouter();
  const plans = useAsync(() => (user ? api<Plans>(`/billing/plans?platform=${Platform.OS === 'ios' ? 'ios' : 'android'}`) : Promise.resolve(null)), [user?.id]);
  const status = useAsync(() => (user ? api<Status>('/billing/status') : Promise.resolve(null)), [user?.id]);
  const [busy, setBusy] = useState(false);
  const pending = useRef<string | null>(null);

  // After the payment page, the person returns to the app: ask the server to confirm instead of waiting for the webhook.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s !== 'active' || !pending.current) return;
      const reference = pending.current;
      try {
        const r = await api<{ status: string; tier: string }>('/billing/verify', { body: { reference } });
        if (r.status === 'SUCCEEDED') { pending.current = null; await refresh(); status.reload(); plans.reload(); Alert.alert('Welcome to Premium', 'Your upgrade is active.'); }
        else if (r.status === 'FAILED' || r.status === 'ABANDONED') { pending.current = null; Alert.alert('Payment not completed', 'No money was taken for this attempt. You can try again.'); }
      } catch { /* still waiting; the next return to the app asks again */ }
    });
    return () => sub.remove();
  }, [refresh, status, plans]);

  if (!ready) return <LoadingState />;
  if (!user) return <View style={{ flex: 1, padding: space.xl, justifyContent: 'center', gap: space.md }}><Text style={type.h2}>Sign in to see Premium</Text><Button title="Sign in" onPress={() => router.push('/login')} /></View>;
  if ((plans.loading && !plans.data) || (status.loading && !status.data)) return <LoadingState />;
  if (plans.error) return <ErrorState error={plans.error} onRetry={plans.reload} />;
  const p = plans.data;
  const st = status.data;
  const plan = p?.plans[0];
  const active = !!st?.subscription?.active;

  const upgrade = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await api<{ checkoutUrl: string; reference: string }>('/billing/checkout', { body: { planKey: plan.key, platform: Platform.OS === 'ios' ? 'ios' : 'android' } });
      pending.current = r.reference;
      await Linking.openURL(r.checkoutUrl);
    } catch (e) { Alert.alert('Could not start the payment', (e as ApiError).message); } finally { setBusy(false); }
  };
  const cancel = () => Alert.alert('Cancel Premium?', 'You keep Premium until the end of the period you have paid for. It will not renew.', [
    { text: 'Keep Premium', style: 'cancel' },
    { text: 'Cancel renewal', style: 'destructive', onPress: () => void api('/billing/cancel', { method: 'POST' }).then(() => { status.reload(); }).catch((e: ApiError) => Alert.alert('Could not cancel', e.message)) },
  ]);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Panel style={{ gap: space.sm }}>
        <Text style={type.title}>{active ? 'You have Premium' : 'Freebie Radar Premium'}</Text>
        {plan?.benefits.map((b) => <Text key={b} style={type.body}>• {b}</Text>)}
        {plan ? <Text style={type.h2}>{plan.prices.find((x) => x.currency === plan.defaultCurrency)?.label ?? plan.prices[0]?.label} / {plan.interval === 'annual' ? 'year' : 'month'}</Text> : null}
      </Panel>

      {active && st?.subscription ? (
        <Panel style={{ gap: space.sm }}>
          <Text style={type.body}>{st.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {st.subscription.currentPeriodEnd ? new Date(st.subscription.currentPeriodEnd).toLocaleDateString() : ''}{st.subscription.status === 'PAST_DUE' ? '. Your last payment did not go through; please update your card.' : ''}</Text>
          {!st.subscription.cancelAtPeriodEnd ? <Button title="Cancel renewal" kind="secondary" onPress={cancel} /> : null}
        </Panel>
      ) : p?.checkoutAllowed && plan ? (
        <View style={{ gap: space.sm }}>
          <Button title="Upgrade" busy={busy} onPress={upgrade} />
          <Text style={type.small}>You pay on a secure page in your browser. Premium is added as soon as the payment is confirmed. Cancel any time; you keep what you paid for.</Text>
        </View>
      ) : (
        <Panel><Text style={type.body}>{p?.reason ?? 'Paid plans are not available yet.'}</Text></Panel>
      )}

      {st?.payments.length ? (
        <View style={{ gap: space.xs }}>
          <Text style={type.h2}>Payments</Text>
          {st.payments.map((x) => <Text key={x.reference} style={[type.small, { color: colors.ink }]}>{new Date(x.createdAt).toLocaleDateString()} · {x.amount} · {x.status.toLowerCase().replace(/_/g, ' ')}</Text>)}
        </View>
      ) : null}
    </ScrollView>
  );
}
