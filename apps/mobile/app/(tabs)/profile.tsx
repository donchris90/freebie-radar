import Constants from 'expo-constants';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, ScrollView, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Button, Chip, EmptyState, Panel } from '../../src/components/ui';
import { colors, space, type } from '../../src/theme';
import { Text } from '../../src/components/Text';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.sm, gap: space.md }}><Text style={[type.body, { flex: 1 }]}>{label}</Text>{children}</View>
);

export default function Profile() {
  const { user, logout, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const patch = async (body: object) => { try { await api('/me/preferences', { method: 'PATCH', body }); await refresh(); } catch (e) { Alert.alert('Could not save', (e as ApiError).message); } };

  const enablePush = async () => {
    // Push needs a development build: Expo Go cannot register push tokens (and expo-notifications' native
    // module is missing there). The module is therefore loaded only here, never at app start.
    if (Constants.executionEnvironment === 'storeClient') {
      Alert.alert('Push needs a development build', 'Push notifications do not work inside Expo Go. Alerts will still appear in the Alerts tab.');
      return;
    }
    setBusy(true);
    try {
      const Notifications = await import('expo-notifications');
      const perm = await Notifications.requestPermissionsAsync();
      if (perm.status !== 'granted') { Alert.alert('Notifications are off', 'Allow notifications in your phone settings to receive alerts.'); return; }
      const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
      if (!projectId) { Alert.alert('Push is not configured', 'This build has no Expo project ID, so a push token cannot be created yet.'); return; }
      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      await patch({ pushToken: token, pushEnabled: true });
    } catch { Alert.alert('Could not enable notifications', 'Notifications are not available in this build.'); } finally { setBusy(false); }
  };

  if (!user) return (
    <SafeAreaView style={{ flex: 1 }}>
      <EmptyState icon="radio" title="Welcome to Freebie Radar" body="Browse without an account. Sign in to save listings, create alerts and post items." action={<View style={{ gap: space.sm, alignSelf: 'stretch', paddingHorizontal: space.xl }}><Button title="Sign in" onPress={() => router.push('/login')} /><Button title="Create account" kind="secondary" onPress={() => router.push('/register')} /><Button title="Resale calculator" kind="secondary" onPress={() => router.push('/resale')} /></View>} />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: 'display', fontWeight: '800', fontSize: 26, color: '#fff' }}>{user.displayName.trim().charAt(0).toUpperCase() || '?'}</Text>
          </View>
          <View style={{ flex: 1 }}><Text style={type.title} numberOfLines={1}>{user.displayName}</Text><Text style={type.small} numberOfLines={1}>{user.email} · {user.tier.toLowerCase()} plan</Text></View>
        </View>
        <View style={{ gap: space.sm }}>
          <Button icon="add-circle" title="Post an item" onPress={() => router.push('/sell')} />
          <Button title="My listings" kind="secondary" onPress={() => router.push('/my-listings')} />
          <Button title="Resale calculator" kind="secondary" onPress={() => router.push('/resale')} />
        </View>
        <Panel>
          <Text style={type.h2}>Preferences</Text>
          <Row label="Distance unit"><View style={{ flexDirection: 'row', gap: 6 }}>{(['mi', 'km'] as const).map((u) => <Chip key={u} label={u} selected={user.prefs.distanceUnit === u} onPress={() => patch({ distanceUnit: u })} />)}</View></Row>
          <Row label="Personalised recommendations"><Switch accessibilityLabel="Personalised recommendations" value={user.prefs.personalisationEnabled} onValueChange={(v) => patch({ personalisationEnabled: v })} trackColor={{ true: colors.accent, false: colors.line }} /></Row>
          <Row label="Push notifications"><Switch accessibilityLabel="Push notifications" value={user.prefs.pushEnabled && user.prefs.pushTokenSet} onValueChange={(v) => (v ? enablePush() : patch({ pushEnabled: false }))} trackColor={{ true: colors.accent, false: colors.line }} disabled={busy} /></Row>
          <Button title="Reset personalisation" kind="secondary" onPress={async () => { try { await api('/me/personalisation/reset', { method: 'POST' }); Alert.alert('Reset', 'Your activity-based recommendations were cleared.'); } catch (e) { Alert.alert('Could not reset', (e as ApiError).message); } }} />
        </Panel>
        <Panel style={{ gap: space.sm }}>
          <Text style={type.h2}>Privacy</Text>
          <Text style={type.body}>Your location is used only when the app is open, and only to find nearby listings. Other people only ever see an approximate location for your listings.</Text>
        </Panel>
        <Button title="Sign out" kind="secondary" onPress={logout} />
        <Button title="Delete my account" kind="danger" onPress={() => Alert.alert('Delete account?', 'This removes your listings and anonymises your account. It cannot be undone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: async () => { try { await api('/me', { method: 'DELETE' }); await logout(); } catch (e) { Alert.alert('Could not delete', (e as ApiError).message); } } }])} />
      </ScrollView>
    </SafeAreaView>
  );
}
