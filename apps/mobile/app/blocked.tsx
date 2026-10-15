import React from 'react';
import { Alert, FlatList, View } from 'react-native';
import { api, ApiError } from '../src/api';
import { Text } from '../src/components/Text';
import { Button, EmptyState, ErrorState, LoadingState, Panel } from '../src/components/ui';
import { space, type } from '../src/theme';
import { useAsync } from '../src/useAsync';

interface Block { userId: string; displayName: string; blockedAt: string }

export default function Blocked() {
  const state = useAsync(async () => (await api<{ items: Block[] }>('/me/blocks')).items, []);
  const unblock = async (b: Block) => {
    try { await api(`/me/blocks/${b.userId}`, { method: 'DELETE' }); state.reload(); }
    catch (e) { Alert.alert('Could not unblock', (e as ApiError).message); }
  };
  if (state.loading && !state.data) return <LoadingState />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  return (
    <FlatList
      data={state.data ?? []} keyExtractor={(b) => b.userId} contentContainerStyle={{ padding: space.lg, gap: space.md }}
      ListEmptyComponent={<EmptyState icon="shield-checkmark-outline" title="No blocked sellers" body="Block a seller from any of their listings and their items stop appearing for you." />}
      renderItem={({ item }) => (
        <Panel style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <Text style={type.h2} numberOfLines={1}>{item.displayName}</Text>
            <Text style={type.small}>Blocked {new Date(item.blockedAt).toLocaleDateString()}</Text>
          </View>
          <Button title="Unblock" kind="secondary" onPress={() => unblock(item)} />
        </Panel>
      )}
    />
  );
}
