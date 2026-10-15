import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, CATEGORIES, ListingView, Page, titleCase } from '../../src/api';
import { AdSlot } from '../../src/ads';
import { useAuth } from '../../src/auth';
import { ListingCard } from '../../src/components/ListingCard';
import { LocationBar } from '../../src/components/LocationBar';
import { Mark, Rings } from '../../src/components/Radar';
import { Text } from '../../src/components/Text';
import { Button, Chip, EmptyState, ErrorState, LoadingState, Section } from '../../src/components/ui';
import { useLocationState } from '../../src/location';
import { colors, radius, space, type } from '../../src/theme';
import { useAsync } from '../../src/useAsync';

function Row({ state, empty }: { state: ReturnType<typeof useAsync<ListingView[]>>; empty: React.ReactNode }) {
  if (state.loading && !state.data) return <LoadingState />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!state.data?.length) return <>{empty}</>;
  return <FlatList horizontal showsHorizontalScrollIndicator={false} data={state.data} keyExtractor={(i) => i.id} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: 12 }} renderItem={({ item }) => <ListingCard item={item} width={250} />} />;
}

export default function Discover() {
  useFocusEffect(useCallback(() => { setStatusBarStyle('light'); return () => setStatusBarStyle('dark'); }, []));
  const { place, useCurrent, busy } = useLocationState();
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const unit = user?.prefs.distanceUnit ?? 'km';
  const loc = place ? { lat: place.lat, lng: place.lng } : {};

  const free = useAsync(async () => place ? (await api<Page<ListingView>>('/feed/free-near-me', { query: { ...loc, radius: unit === 'mi' ? 15 : 25, unit, limit: 10 } })).items : [], [place?.lat, place?.lng, unit]);
  const deals = useAsync(async () => (await api<{ items: ListingView[] }>('/feed/exceptional-deals', { query: { ...loc, unit } })).items, [place?.lat, place?.lng, unit]);
  const recent = useAsync(async () => (await api<Page<ListingView>>('/listings', { query: { ...loc, unit, sort: 'newest', limit: 10 } })).items, [place?.lat, place?.lng, unit]);
  const rec = useAsync(async () => user ? await api<{ items: ListingView[]; reason: string }>('/feed/recommended', { query: { ...loc, unit, limit: 10 } }) : null, [user?.id, place?.lat, place?.lng]);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); free.reload(); deals.reload(); recent.reload(); rec.reload(); setTimeout(() => setRefreshing(false), 600); };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />} contentContainerStyle={{ paddingBottom: space.xl * 2 }}>
        <SafeAreaView edges={['top']} style={s.hero}>
          <View style={s.rings}><Rings size={360} /></View>
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl, gap: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Mark size={26} />
              <Text style={{ fontFamily: 'display', fontWeight: '800', fontSize: 18, color: '#fff', letterSpacing: -0.3 }}>Freebie Radar</Text>
            </View>
            <Text accessibilityRole="header" style={[type.hero, { marginTop: space.sm, maxWidth: 300 }]}>Free finds and real deals near you</Text>
            <LocationBar onDark />
            <View style={s.search}>
              <Ionicons name="search" size={18} color={colors.muted} />
              <TextInput accessibilityLabel="Search listings" value={q} onChangeText={setQ} placeholder="Search free items and deals" placeholderTextColor={colors.placeholder} returnKeyType="search" onSubmitEditing={() => router.push({ pathname: '/search', params: { q } })} style={s.searchInput} />
            </View>
          </View>
        </SafeAreaView>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingVertical: space.lg }}>
          {CATEGORIES.map((c) => <Chip key={c} label={titleCase(c)} onPress={() => router.push({ pathname: '/search', params: { category: c } })} />)}
        </ScrollView>

        <Section title="Free near me" right={<Pressable onPress={() => router.push({ pathname: '/search', params: { freeOnly: '1' } })}><Text style={s.link}>See all</Text></Pressable>}>
          {place ? <Row state={free} empty={<EmptyState title="No free items nearby yet" body="Nothing free has been posted within range. Check back soon or widen your search." />} />
            : <EmptyState icon="location-outline" title="Set your location" body="Choose where to look and we will show free items near you." action={<Button title="Use my location" busy={busy} onPress={useCurrent} />} />}
        </Section>

        <AdSlot placement="home" />
        <Section title="Exceptional deals">
          <Text style={[type.small, { paddingHorizontal: space.lg, marginBottom: space.sm }]}>Deal Scores appear only when enough comparable listings exist.</Text>
          <Row state={deals} empty={<EmptyState title="No scored deals yet" body="We only score a listing when there is enough comparable price evidence." />} />
        </Section>

        {user ? (
          <Section title="Recommended for you">
            {rec.data ? <Text style={[type.small, { paddingHorizontal: space.lg, marginBottom: space.sm }]}>{rec.data.reason}</Text> : null}
            <Row state={{ ...rec, data: rec.data?.items ?? null } as ReturnType<typeof useAsync<ListingView[]>>} empty={<EmptyState title="Nothing to recommend yet" body="Save or open a few listings and this feed will adapt. You can turn it off in Profile." />} />
          </Section>
        ) : null}

        <View style={{ paddingHorizontal: space.lg, marginBottom: space.md }}>
          <Button icon="eye-outline" title="Spotted something free outside?" kind="secondary" onPress={() => router.push('/spotted')} />
        </View>

        <Section title="Recently added">
          <Row state={recent} empty={<EmptyState title="No listings yet" body="Be the first to post an item in your area." action={<Button title="Post an item" onPress={() => router.push('/sell')} />} />} />
        </Section>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  hero: { backgroundColor: colors.accent, borderBottomLeftRadius: radius.xl, borderBottomRightRadius: radius.xl, overflow: 'hidden' },
  rings: { position: 'absolute', right: -130, top: -70 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: space.lg, minHeight: 52 },
  searchInput: { flex: 1, fontSize: 16, color: colors.ink, minHeight: 52, fontFamily: 'DMSans_400Regular' },
  link: { color: colors.accent, fontWeight: '700', fontSize: 14 },
});
