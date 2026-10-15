import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { api, ApiError, ChatMessage, ConversationSummary } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Text } from '../../src/components/Text';
import { Button, ErrorState, LoadingState } from '../../src/components/ui';
import { colors, radius, space, type } from '../../src/theme';

const POLL_MS = 10_000;
const MAX = 1000;
const REASONS: [string, string][] = [['SPAM', 'Spam'], ['SCAM', 'Looks like a scam'], ['HARASSMENT', 'Rude or threatening'], ['CONTACT_DETAILS', 'Pushes me off the app'], ['OTHER', 'Something else']];

export default function Conversation() {
  const { id, listingId, title } = useLocalSearchParams<{ id: string; listingId?: string; title?: string }>();
  const isNew = id === 'new';
  const { user, ready } = useAuth();
  const router = useRouter();
  const nav = useNavigation();
  const [conv, setConv] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const list = useRef<FlatList<ChatMessage>>(null);

  const load = useCallback(async () => {
    if (isNew || !user) return;
    try {
      const r = await api<{ conversation: ConversationSummary; messages: ChatMessage[] }>(`/conversations/${id}`);
      setConv(r.conversation); setMessages(r.messages); setError(null);
    } catch (e) { setError(e as Error); } finally { setLoading(false); }
  }, [id, isNew, user]);

  // Refresh when the screen is focused and every few seconds while it is. Push only says "new message".
  useFocusEffect(useCallback(() => { void load(); const t = setInterval(() => void load(), POLL_MS); return () => clearInterval(t); }, [load]));
  useEffect(() => { nav.setOptions({ title: isNew ? (title ? `About: ${title}` : 'New message') : conv ? conv.other.displayName : 'Conversation' }); }, [nav, isNew, title, conv]);
  useEffect(() => { if (messages.length) setTimeout(() => list.current?.scrollToEnd({ animated: false }), 50); }, [messages.length]);

  if (!ready) return <LoadingState />;
  if (!user) return <View style={{ flex: 1, padding: space.xl, justifyContent: 'center', gap: space.md }}><Text style={type.h2}>Sign in to message sellers</Text><Button title="Sign in" onPress={() => router.push('/login')} /></View>;
  if (loading) return <LoadingState />;
  if (error && !conv && !isNew) return <ErrorState error={error instanceof ApiError && error.status === 404 ? new Error('This conversation is no longer available.') : error} onRetry={() => void load()} />;

  const canWrite = isNew || !!conv?.canReply;
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (isNew) {
        const r = await api<{ conversationId: string }>(`/listings/${listingId}/conversations`, { body: { message: body } });
        router.replace({ pathname: '/conversation/[id]', params: { id: r.conversationId } });
      } else {
        const m = await api<ChatMessage>(`/conversations/${id}/messages`, { body: { message: body } });
        setMessages((prev) => [...prev, m]); setText('');
        void load();
      }
    } catch (e) { Alert.alert('Could not send', (e as ApiError).message); } finally { setSending(false); }
  };

  const report = (m: ChatMessage) => {
    const choose = (reason: string) => api(`/messages/${m.id}/report`, { body: { reason } })
      .then(() => { Alert.alert('Thanks, we will review it', 'You will not see messages from this person again.'); router.back(); })
      .catch((e: ApiError) => Alert.alert('Could not report', e.message));
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ title: 'Report this message', options: [...REASONS.map(([, l]) => l), 'Cancel'], cancelButtonIndex: REASONS.length }, (i) => { if (i < REASONS.length) void choose(REASONS[i][0]); });
    else Alert.alert('Report this message', 'What is wrong with it?', [...REASONS.slice(0, 3).map(([k, l]) => ({ text: l, onPress: () => void choose(k) })), { text: 'Cancel', style: 'cancel' as const }]);
  };
  const block = () => Alert.alert('Block this person?', 'The conversation disappears and they cannot message you. They are not told. You can undo this in Profile.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Block', style: 'destructive', onPress: () => void api(`/conversations/${id}/block`, { method: 'POST' }).then(() => router.back()).catch((e: ApiError) => Alert.alert('Could not block', e.message)) },
  ]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      {isNew ? <View style={{ padding: space.lg, gap: 4 }}>
        <Text style={type.h2}>Say hello</Text>
        <Text style={type.small}>Ask about condition or pickup. Phone numbers, emails and links are not allowed in chat, and you should never pay before you have seen the item.</Text>
      </View> : null}
      <FlatList
        ref={list} data={messages} keyExtractor={(m) => m.id} contentContainerStyle={{ padding: space.lg, gap: space.sm, flexGrow: 1 }}
        ListHeaderComponent={conv ? <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/listing/[id]', params: { id: conv.listing.id } })} style={{ paddingBottom: space.sm }}><Text style={[type.small, { color: colors.accent, textDecorationLine: 'underline' }]}>About: {conv.listing.title}</Text></Pressable> : null}
        renderItem={({ item: m }) => (
          <View style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '82%', gap: 4 }}>
            <Pressable accessibilityHint={m.mine ? undefined : 'Long press to report'} onLongPress={m.mine ? undefined : () => report(m)}
              style={{ backgroundColor: m.mine ? colors.accent : colors.surface, borderRadius: radius.lg, paddingVertical: space.sm, paddingHorizontal: space.md, borderWidth: m.mine ? 0 : 1, borderColor: colors.line }}>
              <Text style={[type.body, m.mine && { color: '#fff' }]}>{m.body}</Text>
            </Pressable>
            {m.caution ? <Text style={[type.small, { color: colors.caution, backgroundColor: colors.cautionSoft, borderRadius: radius.md, padding: space.sm }]}>{m.caution}</Text> : null}
            <Text style={[type.small, { alignSelf: m.mine ? 'flex-end' : 'flex-start' }]}>{new Date(m.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</Text>
          </View>
        )}
        ListFooterComponent={!isNew && messages.some((m) => !m.mine) ? <Text style={[type.small, { marginTop: space.md }]}>Long-press a message from them to report it.</Text> : null}
      />
      {conv && !canWrite ? <View style={{ padding: space.lg, backgroundColor: colors.cautionSoft }}><Text style={type.body}>{conv.closedMessage}</Text></View> : null}
      {canWrite ? (
        <View style={{ padding: space.md, flexDirection: 'row', gap: space.sm, alignItems: 'flex-end', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface }}>
          <TextInput accessibilityLabel="Message" value={text} onChangeText={setText} multiline maxLength={MAX} placeholder="Write a message" placeholderTextColor={colors.placeholder}
            style={{ flex: 1, maxHeight: 120, minHeight: 44, borderWidth: 1.5, borderColor: colors.line, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: 10, fontSize: 15, color: colors.ink }} />
          <Button title="Send" busy={sending} disabled={!text.trim()} onPress={send} />
        </View>
      ) : null}
      {!isNew && conv ? <View style={{ padding: space.sm, alignItems: 'center', backgroundColor: colors.surface }}><Pressable accessibilityRole="button" onPress={block}><Text style={[type.small, { textDecorationLine: 'underline' }]}>Block this person</Text></Pressable></View> : null}
    </KeyboardAvoidingView>
  );
}
