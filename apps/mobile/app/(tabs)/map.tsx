import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ListingView, Page } from '../../src/api';
import { useAuth } from '../../src/auth';
import { ListingCard } from '../../src/components/ListingCard';
import { LocationBar } from '../../src/components/LocationBar';
import { Button, Chip, EmptyState, ErrorState, LoadingState } from '../../src/components/ui';
import { useLocationState } from '../../src/location';
import { colors, space } from '../../src/theme';
import { useAsync } from '../../src/useAsync';

export default function MapTab() {
  const { place, useCurrent, busy } = useLocationState();
  const { user } = useAuth();
  const unit = user?.prefs.distanceUnit ?? 'km';
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [freeOnly, setFreeOnly] = useState(false);
  const state = useAsync(async () => place ? (await api<Page<ListingView>>('/listings', { query: { lat: place.lat, lng: place.lng, radius: unit === 'mi' ? 15 : 25, unit, freeOnly: freeOnly || undefined, limit: 50 } })).items : [], [place?.lat, place?.lng, unit, freeOnly]);
  const region = useMemo(() => place ? { latitude: place.lat, longitude: place.lng, latitudeDelta: 0.25, longitudeDelta: 0.25 } : undefined, [place?.lat, place?.lng]);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      <View style={{ padding: space.lg, gap: space.sm }}>
        <LocationBar />
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Chip label="Map" selected={mode === 'map'} onPress={() => setMode('map')} />
          <Chip label="List" selected={mode === 'list'} onPress={() => setMode('list')} />
          <Chip label="Free only" selected={freeOnly} onPress={() => setFreeOnly(!freeOnly)} />
        </View>
      </View>
      {!place || !region ? <EmptyState title="Set your location" body="Pick where to look and listings appear on the map." action={<Button title="Use my location" busy={busy} onPress={useCurrent} />} />
        : state.loading && !state.data ? <LoadingState />
        : state.error ? <ErrorState error={state.error} onRetry={state.reload} />
        : !state.data?.length ? <EmptyState title="Nothing here yet" body="No listings within range. Pins appear only for real listings, never placeholders." />
        : mode === 'map' ? (
          <View style={{ flex: 1 }}><MapView style={{ flex: 1 }} initialRegion={region} accessibilityLabel="Map of nearby listings">
            {state.data.map((l) => (
              <Marker key={l.id} coordinate={{ latitude: l.location.lat, longitude: l.location.lng }} title={l.title} description={`${l.price.label} · approximate location`} pinColor={l.price.isFree ? colors.sticker : colors.accent} onCalloutPress={() => router.push(`/listing/${l.id}`)} />
            ))}
          </MapView></View>
        ) : <FlatList data={state.data} keyExtractor={(i) => i.id} contentContainerStyle={{ padding: space.lg, gap: space.md }} renderItem={({ item }) => <ListingCard item={item} />} />}
    </SafeAreaView>
  );
}
