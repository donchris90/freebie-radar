import { router } from 'expo-router';
import React from 'react';
import { FlatList, View } from 'react-native';
import { api, ListingView, titleCase } from '../src/api';
import { Button, Chip, EmptyState, ErrorState, LoadingState } from '../src/components/ui';
import { colors, radius, space, type } from '../src/theme';
import { useAsync } from '../src/useAsync';
import { Text } from '../src/components/Text';

export default function MyListings() {
  const state = useAsync(async () => (await api<{ items: ListingView[] }>('/listings/mine')).items, []);
  if (state.loading && !state.data) return <LoadingState />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  return (
    <FlatList data={state.data ?? []} keyExtractor={(i) => i.id} contentContainerStyle={{ padding: space.lg, gap: space.md }}
      ListEmptyComponent={<EmptyState title="You have not posted anything" action={<Button title="Post an item" onPress={() => router.push('/sell')} />} />}
      renderItem={({ item }) => (
        <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: 6 }}>
          <Text style={type.h2}>{item.title}</Text>
          <Text style={type.body}>{item.price.label} · {item.freshness.label}</Text>
          <View style={{ flexDirection: 'row', gap: space.sm }}><Chip label={titleCase(item.status)} tone={item.status === 'ACTIVE' ? 'free' : 'caution'} /><Chip label={item.risk.label} tone={item.risk.level === 'NO_MAJOR_SIGNALS' ? 'muted' : 'caution'} /></View>
          {item.status === 'UNDER_REVIEW' ? <Text style={type.small}>This listing is being reviewed and is not public yet. If you think that is a mistake, contact support to appeal.</Text> : null}
          <Button title="Open" kind="secondary" onPress={() => router.push(`/listing/${item.id}`)} />
        </View>
      )} />
  );
}
