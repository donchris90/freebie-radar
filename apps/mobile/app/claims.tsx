import { router } from 'expo-router';
import React from 'react';
import { Alert, Image, Pressable, ScrollView, View } from 'react-native';
import { api, ApiError, ClaimStatus, ClaimView } from '../src/api';
import { useAuth } from '../src/auth';
import { Button, Chip, EmptyState, ErrorState, LoadingState } from '../src/components/ui';
import { Text } from '../src/components/Text';
import { colors, radius, space, type } from '../src/theme';
import { useAsync } from '../src/useAsync';

const LABEL: Record<ClaimStatus, string> = { HELD: 'Waiting for the giver', CONFIRMED: 'Confirmed: arrange pickup', COLLECTED: 'Collected', CANCELLED: 'Cancelled', EXPIRED: 'Expired', NO_SHOW: 'Missed pickup' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null);

function ClaimRow({ c, onChange }: { c: ClaimView; onChange: () => void }) {
  const act = async (what: 'confirm' | 'collected' | 'no-show' | 'cancel') => {
    try { await api(`/claims/${c.id}/${what}`, { method: 'POST' }); onChange(); } catch (e) { Alert.alert('Something went wrong', (e as ApiError).message); onChange(); }
  };
  const active = c.status === 'HELD' || c.status === 'CONFIRMED';
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.sm }}>
      <Pressable accessibilityRole="button" onPress={() => router.push(`/listing/${c.listing.id}`)} style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
        {c.listing.image ? <Image source={{ uri: c.listing.image }} style={{ width: 56, height: 56, borderRadius: 10, backgroundColor: colors.imageBg }} accessibilityIgnoresInvertColors /> : null}
        <View style={{ flex: 1 }}>
          <Text style={type.h2} numberOfLines={2}>{c.listing.title}</Text>
          <Text style={type.small}>{c.role === 'GIVER' ? `Wanted by ${c.other.displayName}` : `Giver: ${c.other.displayName}`}</Text>
        </View>
      </Pressable>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        <Chip label={LABEL[c.status]} tone={active ? 'free' : 'muted'} />
        {c.role === 'GIVER' && c.claimerReliability ? <Chip label={c.claimerReliability.text} tone={c.claimerReliability.label === 'UNRELIABLE' ? 'caution' : 'muted'} /> : null}
      </View>
      {active && c.expiresAt ? <Text style={type.small}>{c.status === 'HELD' ? 'Released automatically at' : 'Pickup by'} {when(c.expiresAt)}</Text> : null}
      {c.actions.confirm ? <Button title="Confirm this person" onPress={() => act('confirm')} /> : null}
      {c.actions.collected ? <Button title="Mark as collected" kind="secondary" onPress={() => act('collected')} /> : null}
      {c.actions.noShow ? <Button title="They did not come" kind="secondary" onPress={() => Alert.alert('Report a no-show?', 'The item becomes available to others again. This is recorded on their reliability.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Report', style: 'destructive', onPress: () => void act('no-show') }])} /> : null}
      {c.actions.cancel ? <Button title={c.role === 'GIVER' ? 'Release the item' : 'Cancel my reservation'} kind="secondary" onPress={() => act('cancel')} /> : null}
    </View>
  );
}

export default function Claims() {
  const { user } = useAuth();
  const state = useAsync(() => (user ? api<{ asClaimer: ClaimView[]; asGiver: ClaimView[] }>('/claims/mine') : Promise.resolve(null)), [user?.id]);
  if (!user) return <EmptyState title="Sign in to see reservations" action={<Button title="Sign in" onPress={() => router.replace('/login')} />} />;
  if (state.loading && !state.data) return <LoadingState />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  const d = state.data ?? { asClaimer: [], asGiver: [] };
  if (!d.asClaimer.length && !d.asGiver.length) return <EmptyState icon="lock-closed-outline" title="No reservations yet" body="Open a free item and tap “I'll take it” to hold it while you arrange pickup." action={<Button title="Find free items" onPress={() => router.replace('/')} />} />;
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      {d.asGiver.length ? <View style={{ gap: space.md }}><Text style={type.h2}>People who want your items</Text>{d.asGiver.map((c) => <ClaimRow key={c.id} c={c} onChange={state.reload} />)}</View> : null}
      {d.asClaimer.length ? <View style={{ gap: space.md }}><Text style={type.h2}>Items you reserved</Text>{d.asClaimer.map((c) => <ClaimRow key={c.id} c={c} onChange={state.reload} />)}</View> : null}
    </ScrollView>
  );
}
