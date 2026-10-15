import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { api, ApiError } from '../src/api';
import { useAuth } from '../src/auth';
import { Text } from '../src/components/Text';
import { Button, Field } from '../src/components/ui';
import { colors, space, type } from '../src/theme';

export default function VerifyEmail() {
  const { user, refresh } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user) return <Text style={[type.body, { padding: space.lg }]}>Sign in to verify your email.</Text>;
  if (user.emailVerified) return <Text style={[type.body, { padding: space.lg }]}>Your email is already verified.</Text>;

  const send = async () => {
    setBusy(true); setError(null); setInfo(null);
    try { await api('/me/email/send-code', { method: 'POST' }); setInfo(`We sent a code to ${user.email}.`); }
    catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try { await api('/me/email/verify', { body: { code: code.trim() } }); await refresh(); Alert.alert('Email verified'); router.back(); }
    catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Text style={type.title}>Verify your email</Text>
      <Text style={type.body}>Enter the 8-character code we emailed to {user.email}. Verified accounts can post listings and recover their password.</Text>
      <Field label="Code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="ABCD-2345" />
      {info ? <Text accessibilityLiveRegion="polite" style={type.small}>{info}</Text> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Verify" busy={busy} disabled={code.trim().length < 8} onPress={verify} />
      <Button title="Email me a new code" kind="secondary" busy={busy} onPress={send} />
    </ScrollView>
  );
}
