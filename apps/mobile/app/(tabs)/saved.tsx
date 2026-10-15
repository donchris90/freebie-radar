import { router } from 'expo-router';
import React from 'react';
import { FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ListingView } from '../../src/api';
import { useAuth } from '../../src/auth';
import { ListingCard } from '../../src/components/ListingCard';
import { Button, EmptyState, ErrorState, LoadingState } from '../../src/components/ui';
import { useSaved } from '../../src/saved';
import { space, type } from '../../src/theme';
import { useAsync } from '../../src/useAsync';
import { Text } from '../../src/components/Text';

export default function Saved() {
  const { user, ready } = useAuth();
  const { ids } = useSaved();
  const state = useAsync(async () => user ? (await api<{ items: ListingView[] }>('/saved')).items : [], [user?.id, ids.size]);
  if (!ready) return <LoadingState />;
  if (!user) return <SafeAreaView style={{ flex: 1 }}><EmptyState icon="heart-outline" title="Your saved listings" body="Sign in to keep track of listings you like." action={<Button title="Sign in" onPress={() => router.push('/login')} />} /></SafeAreaView>;
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      <FlatList data={state.data ?? []} keyExtractor={(i) => i.id} contentContainerStyle={{ padding: space.lg, gap: space.md }}
        ListHeaderComponent={<Text style={[type.title, { marginBottom: space.sm }]}>Saved</Text>}
        ListEmptyComponent={state.loading ? <LoadingState /> : state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : <EmptyState icon="heart-outline" title="Nothing saved yet" body="Tap the heart on a listing to save it. Listings that are no longer available drop off this list." />}
        renderItem={({ item }) => <ListingCard item={item} />} />
    </SafeAreaView>
  );
}
