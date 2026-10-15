import { router } from 'expo-router';
import React from 'react';
import { Alert, FlatList, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AlertView, api, ApiError, titleCase } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Button, EmptyState, ErrorState, LoadingState, Panel } from '../../src/components/ui';
import { exponent } from '../../src/money';
import { colors, space, type } from '../../src/theme';
import { useAsync } from '../../src/useAsync';
import { Text } from '../../src/components/Text';

function summary(a: AlertView, unit: string) {
  const parts: string[] = [];
  if (a.keywords.length) parts.push(`“${a.keywords.join(', ')}”`);
  if (a.freeOnly) parts.push('free only');
  if (a.maxPriceMinor !== null && a.currency) parts.push(`under ${(a.maxPriceMinor / 10 ** exponent(a.currency)).toLocaleString(undefined, { style: 'currency', currency: a.currency })}`);
  if (a.radiusKm !== null) parts.push(`within ${unit === 'mi' ? Math.round(a.radiusKm / 1.609344) : Math.round(a.radiusKm)} ${unit}`);
  if (a.minDealScore !== null) parts.push(`Deal Score ${a.minDealScore}+`);
  if (a.categories.length) parts.push(a.categories.map(titleCase).join(', '));
  return parts.join(' · ');
}

export default function Alerts() {
  const { user, ready } = useAuth();
  const state = useAsync(async () => user ? await api<AlertView[]>('/alerts') : [], [user?.id]);
  if (!ready) return <LoadingState />;
  if (!user) return <SafeAreaView style={{ flex: 1 }}><EmptyState icon="notifications" title="Radar Alerts" body="Sign in to get notified the moment a matching free item or deal appears." action={<Button title="Sign in" onPress={() => router.push('/login')} />} /></SafeAreaView>;

  const toggle = async (a: AlertView, active: boolean) => {
    try { await api(`/alerts/${a.id}`, { method: 'PATCH', body: { active } }); state.reload(); } catch (e) { Alert.alert('Could not update alert', (e as ApiError).message); }
  };
  const remove = (a: AlertView) => Alert.alert('Delete alert?', a.name, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: async () => { try { await api(`/alerts/${a.id}`, { method: 'DELETE' }); state.reload(); } catch (e) { Alert.alert('Could not delete', (e as ApiError).message); } } }]);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      <FlatList
        data={state.data ?? []} keyExtractor={(a) => a.id} contentContainerStyle={{ padding: space.lg, gap: space.md }}
        ListHeaderComponent={<View style={{ gap: space.sm, marginBottom: space.sm }}><Text style={type.title}>Radar Alerts</Text>{!user.prefs.pushTokenSet ? <Text style={[type.small, { color: colors.caution }]}>Notifications are not enabled yet. Turn them on in Profile so alerts can reach you.</Text> : null}<Button icon="add-circle" title="New alert" onPress={() => router.push('/alerts/new')} /></View>}
        ListEmptyComponent={state.loading ? <LoadingState /> : state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : <EmptyState icon="notifications-outline" title="No alerts yet" body={'Try “a used MacBook under $250 within 10 miles”.'} />}
        renderItem={({ item }) => (
          <Panel style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={[type.h2, { flex: 1 }]} numberOfLines={1}>{item.name}</Text>
              <Switch accessibilityLabel={`${item.name} active`} value={item.active} onValueChange={(v) => toggle(item, v)} trackColor={{ true: colors.accent, false: colors.line }} />
            </View>
            <Text style={type.body}>{summary(item, user.prefs.distanceUnit) || 'Any new listing'}</Text>
            <Text style={type.small}>{titleCase(item.frequency)} delivery</Text>
            <Button title="Delete" kind="secondary" onPress={() => remove(item)} />
          </Panel>
        )}
      />
    </SafeAreaView>
  );
}
