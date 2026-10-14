import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, CATEGORIES, ListingView, Page, titleCase } from '../../src/api';
import { useAuth } from '../../src/auth';
import { ListingCard } from '../../src/components/ListingCard';
import { LocationBar } from '../../src/components/LocationBar';
import { Button, Chip, EmptyState, ErrorState, LoadingState, Section } from '../../src/components/ui';
import { useLocationState } from '../../src/location';
import { colors, radius, space, type } from '../../src/theme';
import { useAsync } from '../../src/useAsync';

function Row({ state, empty }: { state: ReturnType<typeof useAsync<ListingView[]>>; empty: React.ReactNode }) {
  if (state.loading && !state.data) return <LoadingState />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!state.data?.length) return <>{empty}</>;
  return <FlatList horizontal showsHorizontalScrollIndicator={false} data={state.data} keyExtractor={(i) => i.id} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }} renderItem={({ item }) => <ListingCard item={item} width={240} />} />;
}

export default function Discover() {
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />} contentContainerStyle={{ paddingBottom: space.xl * 2 }}>
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md }}>
          <Text style={type.title}>Find the deals before everyone else</Text>
          <LocationBar />
          <View style={s.search}>
            <Ionicons name="search" size={18} color={colors.muted} />
            <TextInput accessibilityLabel="Search listings" value={q} onChangeText={setQ} placeholder="Search free items and deals" placeholderTextColor="#7A8791" returnKeyType="search" onSubmitEditing={() => router.push({ pathname: '/search', params: { q } })} style={s.searchInput} />
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingVertical: space.lg }}>
          {CATEGORIES.map((c) => <Chip key={c} label={titleCase(c)} onPress={() => router.push({ pathname: '/search', params: { category: c } })} />)}
        </ScrollView>

        <Section title="Free near me" right={<Pressable onPress={() => router.push({ pathname: '/search', params: { freeOnly: '1' } })}><Text style={s.link}>See all</Text></Pressable>}>
          {place ? <Row state={free} empty={<EmptyState title="No free items nearby yet" body="Nothing free has been posted within range. Check back soon or widen your search." />} />
            : <EmptyState title="Set your location" body="Choose where to look and we will show free items near you." action={<Button title="Use my location" busy={busy} onPress={useCurrent} />} />}
        </Section>

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

        <Section title="Recently added">
          <Row state={recent} empty={<EmptyState title="No listings yet" body="Be the first to post an item in your area." action={<Button title="Post an item" onPress={() => router.push('/sell')} />} />} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: space.lg, borderWidth: 1, borderColor: colors.line, minHeight: 48 },
  searchInput: { flex: 1, fontSize: 16, color: colors.ink, minHeight: 48 },
  link: { color: colors.accent, fontWeight: '700', fontSize: 14 },
});
