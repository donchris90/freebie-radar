import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Image, Linking, Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { api, ApiError, ListingView, titleCase } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Button, Chip, ErrorState, LoadingState, Panel, PriceTag } from '../../src/components/ui';
import { useSaved } from '../../src/saved';
import { colors, radius, space, type } from '../../src/theme';
import { useAsync } from '../../src/useAsync';
import { Text } from '../../src/components/Text';

const REASONS = [['UNAVAILABLE', 'No longer available'], ['EXPIRED', 'Expired'], ['SUSPICIOUS', 'Looks suspicious'], ['SCAM', 'Possible scam'], ['DUPLICATE', 'Duplicate'], ['PROHIBITED_ITEM', 'Prohibited item'], ['WRONG_INFO', 'Wrong information'], ['OTHER', 'Something else']] as const;

export default function ListingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { ids, toggle } = useSaved();
  const { width } = useWindowDimensions();
  const state = useAsync(() => api<ListingView>(`/listings/${id}`), [id, user?.id]);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.loading && !state.data) return <LoadingState />;
  if (state.error) return state.error instanceof ApiError && state.error.status === 404
    ? <ErrorState error={new Error('This listing is no longer available.')} />
    : <ErrorState error={state.error} onRetry={state.reload} />;
  const l = state.data!;
  const saved = ids.has(l.id);

  const guard = async (fn: () => Promise<unknown>, ok?: string) => {
    if (!user) { router.push('/login'); return; }
    setBusy(true);
    try { await fn(); if (ok) Alert.alert(ok); state.reload(); } catch (e) { Alert.alert('Something went wrong', (e as ApiError).message); } finally { setBusy(false); }
  };
  const openOriginal = () => Alert.alert('Open the original listing?', 'This leaves Freebie Radar and opens a page we do not control or verify.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Open', onPress: () => void Linking.openURL(l.externalUrl!) }]);

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: space.xl * 2 }}>
      <View>
        {l.images.length ? (
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}>{l.images.map((u) => <Image key={u} source={{ uri: u }} style={{ width, height: 300, backgroundColor: colors.imageBg }} accessibilityIgnoresInvertColors />)}</ScrollView>
        ) : <View style={{ height: 160, backgroundColor: colors.imageBg, alignItems: 'center', justifyContent: 'center' }}><Text style={type.small}>No photos provided</Text></View>}
        <View style={{ position: 'absolute', left: space.lg, bottom: space.lg }}><PriceTag label={l.price.label} free={l.price.isFree} size="lg" /></View>
        {l.images.length > 1 ? <View style={{ position: 'absolute', right: space.lg, bottom: space.lg, backgroundColor: 'rgba(22,20,59,0.75)', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4 }}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{l.images.length} photos · swipe</Text></View> : null}
      </View>

      <View style={{ padding: space.lg, gap: space.md }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {l.sponsored ? <Chip tone="sponsored" label="Sponsored" /> : null}
          <Chip label={titleCase(l.condition)} />
          <Chip label={titleCase(l.category)} />
        </View>
        <Text style={type.title}>{l.title}</Text>
        <Text style={[type.body, l.freshness.stale && { color: colors.caution }]} accessibilityLiveRegion="polite">{l.freshness.label}</Text>
        {l.status === 'POSSIBLY_EXPIRED' ? <Text style={[type.small, { color: colors.caution }]}>We have not had a recent confirmation that this is still available.</Text> : null}

        {l.dealScore ? (
          <View style={{ backgroundColor: colors.ink, borderRadius: radius.lg, padding: space.lg + 4, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <Text style={{ fontFamily: 'display', fontWeight: '800', fontSize: 56, lineHeight: 60, color: '#fff', letterSpacing: -2 }}>{l.dealScore.score}</Text>
              <Text style={{ fontSize: 16, color: 'rgba(255,255,255,0.7)', fontWeight: '700' }}>/100 Deal Score</Text>
            </View>
            <Text style={[type.body, { color: '#fff' }]}>{l.dealScore.explanation}</Text>
            <Text style={[type.small, { color: 'rgba(255,255,255,0.75)' }]}>Based on {l.dealScore.evidence.sampleSize} comparable listings{l.dealScore.evidence.range ? ` (${l.dealScore.evidence.range})` : ''}.</Text>
            {l.dealScore.evidence.limitations.map((x) => <Text key={x} style={[type.small, { color: 'rgba(255,255,255,0.75)' }]}>• {x}</Text>)}
          </View>
        ) : <Panel><Text style={type.label}>Deal Score</Text><Text style={type.body}>{l.dealScoreNote ?? 'Not enough comparable listings to score this one.'}</Text></Panel>}

        <View style={{ gap: 4 }}>
          <Text style={type.h2}>Description</Text>
          <Text style={type.body}>{l.description || 'The seller did not add a description.'}</Text>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={type.h2}>Location</Text>
          <Text style={type.body}>{[l.location.label, l.distance?.label].filter(Boolean).join(' · ') || 'Approximate area only'}</Text>
          <Text style={type.small}>The exact address is never shown. Arrange a pickup point with the seller.</Text>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={type.h2}>Source</Text>
          <Text style={type.body}>{l.source.attribution?.text || l.source.name}</Text>
          {l.source.attribution?.url ? <Text style={[type.small, { color: colors.accent, textDecorationLine: 'underline' }]} accessibilityRole="link" onPress={() => void Linking.openURL(l.source.attribution!.url!)}>{l.source.attribution.url.replace(/^https?:\/\//, '')}</Text> : null}
          <Text style={type.small}>Not independently verified by Freebie Radar.</Text>
        </View>

        <View style={{ backgroundColor: l.risk.level === 'NO_MAJOR_SIGNALS' ? colors.surface : colors.cautionSoft, borderRadius: radius.lg, padding: space.lg, gap: 4, borderWidth: 1, borderColor: l.risk.level === 'NO_MAJOR_SIGNALS' ? colors.line : colors.cautionSoft }}>
          <Text style={type.h2}>{l.risk.label}</Text>
          {l.risk.signals.map((x) => <Text key={x} style={type.body}>• {x}</Text>)}
          {l.risk.level === 'NO_MAJOR_SIGNALS' ? <Text style={type.small}>This is not a guarantee. Always take sensible precautions.</Text> : null}
        </View>

        {l.safetyGuidance ? <View style={{ gap: 4 }}><Text style={type.h2}>Stay safe</Text>{l.safetyGuidance.map((x) => <Text key={x} style={type.body}>• {x}</Text>)}</View> : null}

        <View style={{ gap: space.sm }}>
          {l.externalUrl ? <Button title="Open original listing" onPress={openOriginal} /> : null}
          {l.messageable && !l.isOwner ? <Button icon="chatbubble-ellipses-outline" title="Message seller" onPress={() => (user ? router.push({ pathname: '/conversation/[id]', params: { id: 'new', listingId: l.id, title: l.title } }) : router.push('/login'))} /> : null}
          {!l.externalUrl && !l.messageable && !l.isOwner ? <Text style={type.small}>This listing is not open for messages right now.</Text> : null}
          <Button icon={saved ? 'heart' : 'heart-outline'} title={saved ? 'Saved (tap to remove)' : 'Save listing'} kind="secondary" busy={busy} onPress={() => guard(() => toggle(l.id))} />
          {l.price.minor !== null ? <Button title="Estimate resale profit" kind="secondary" onPress={() => router.push({ pathname: '/resale', params: { purchase: String(l.price.minor! / 100), currency: l.price.currency } })} /> : null}
          {l.isOwner ? <>
            <Button title="Still available — confirm" kind="secondary" busy={busy} onPress={() => guard(() => api(`/listings/${l.id}/confirm`, { method: 'POST' }), 'Thanks, availability confirmed.')} />
            <Button title="Mark as unavailable" kind="secondary" busy={busy} onPress={() => guard(() => api(`/listings/${l.id}/unavailable`, { method: 'POST' }), 'Marked as unavailable.')} />
          </> : <>
            <Button title="Report this listing" kind="secondary" onPress={() => (user ? setReporting(true) : router.push('/login'))} />
            {l.messageable ? <Button title="Block this seller" kind="secondary" onPress={() => (user ? Alert.alert('Block this seller?', 'Their listings will disappear from your feeds and search. They are not told. You can undo this in Profile.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Block', style: 'destructive', onPress: () => void guard(async () => { await api(`/listings/${l.id}/block-seller`, { method: 'POST' }); router.back(); }) }]) : router.push('/login'))} /> : null}
          </>}
        </View>
      </View>

      <Modal visible={reporting} transparent animationType="slide" onRequestClose={() => setReporting(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(22,20,59,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.bg, padding: space.xl, gap: space.md, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }}>
            <Text style={type.h2}>What is wrong with this listing?</Text>
            {REASONS.map(([k, label]) => <Pressable key={k} accessibilityRole="button" onPress={async () => { setReporting(false); await guard(() => api(`/listings/${l.id}/report`, { body: { reason: k } }), 'Thanks. Your report helps keep listings accurate.'); }} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={type.body}>{label}</Text></Pressable>)}
            <Button title="Cancel" kind="secondary" onPress={() => setReporting(false)} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
