import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { api, ApiError } from '../src/api';
import { useAuth } from '../src/auth';
import { Text } from '../src/components/Text';
import { Button, Field } from '../src/components/ui';
import { colors, space, type } from '../src/theme';

export default function ChangePassword() {
  const { adoptSession } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ accessToken: string; refreshToken: string }>('/me/password', { body: { currentPassword: current, newPassword: next } });
      await adoptSession(r); // this phone stays signed in; every other device is signed out
      Alert.alert('Password changed', 'Your other devices have been signed out.');
      router.back();
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password" />
      <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" hint="At least 10 characters." />
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Change password" busy={busy} disabled={!current || next.length < 10} onPress={submit} />
    </ScrollView>
  );
}
