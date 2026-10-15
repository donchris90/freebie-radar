import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { FlatList, Image, Pressable, RefreshControl, View } from 'react-native';
import { api, ConversationSummary } from '../src/api';
import { useAuth } from '../src/auth';
import { Text } from '../src/components/Text';
import { Button, EmptyState, ErrorState, LoadingState } from '../src/components/ui';
import { colors, radius, space, type } from '../src/theme';
import { useAsync } from '../src/useAsync';

export default function Messages() {
  const { user, ready } = useAuth();
  const router = useRouter();
  const state = useAsync(async () => (user ? api<{ items: ConversationSummary[]; unread: number }>('/conversations') : { items: [], unread: 0 }), [user?.id]);
  useFocusEffect(useCallback(() => { if (user) state.reload(); /* refresh when returning from a chat */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]));

  if (!ready) return <LoadingState />;
  if (!user) return <View style={{ flex: 1, padding: space.xl, justifyContent: 'center', gap: space.md }}><Text style={type.h2}>Sign in to see your messages</Text><Button title="Sign in" onPress={() => router.push('/login')} /></View>;
  if (state.loading && !state.data) return <LoadingState />;
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.reload} />;
  return (
    <FlatList
      data={state.data?.items ?? []} keyExtractor={(c) => c.id} contentContainerStyle={{ padding: space.lg, gap: space.sm }}
      refreshControl={<RefreshControl refreshing={state.loading} onRefresh={state.reload} tintColor={colors.accent} />}
      ListEmptyComponent={<EmptyState icon="chatbubbles-outline" title="No messages yet" body="Open a listing and tap “Message seller”. Conversations stay inside the app, so you never have to share a phone number or email." />}
      renderItem={({ item: c }) => (
        <Pressable accessibilityRole="button" accessibilityLabel={`${c.other.displayName}, ${c.listing.title}${c.unread ? ', unread' : ''}`} onPress={() => router.push({ pathname: '/conversation/[id]', params: { id: c.id } })}
          style={{ flexDirection: 'row', gap: space.md, backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.md, borderWidth: 1, borderColor: c.unread ? colors.accent : colors.line, opacity: c.canReply ? 1 : 0.75 }}>
          {c.listing.image ? <Image source={{ uri: c.listing.image }} style={{ width: 56, height: 56, borderRadius: radius.md, backgroundColor: colors.imageBg }} accessibilityIgnoresInvertColors /> : <View style={{ width: 56, height: 56, borderRadius: radius.md, backgroundColor: colors.imageBg }} />}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.body, { fontWeight: c.unread ? '700' : '500' }]} numberOfLines={1}>{c.other.displayName} · {c.listing.title}</Text>
            <Text style={type.small} numberOfLines={2}>{c.closedReason === 'LISTING_UNAVAILABLE' ? 'Listing no longer available' : c.lastMessage ? `${c.lastMessage.mine ? 'You: ' : ''}${c.lastMessage.preview}` : 'No messages yet'}</Text>
          </View>
          {c.unread ? <View accessibilityLabel="Unread" style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, alignSelf: 'center' }} /> : null}
        </Pressable>
      )}
    />
  );
}
