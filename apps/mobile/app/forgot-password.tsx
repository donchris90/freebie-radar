import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { api, ApiError } from '../src/api';
import { Text } from '../src/components/Text';
import { Button, Field } from '../src/components/ui';
import { colors, space, type } from '../src/theme';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setError(null);
    try { await api('/auth/forgot-password', { body: { email: email.trim() } }); setSent(true); }
    catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true); setError(null);
    try {
      await api('/auth/reset-password', { body: { email: email.trim(), code: code.trim(), newPassword: password } });
      Alert.alert('Password changed', 'Sign in with your new password.');
      router.replace('/login');
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Text style={type.title}>Reset your password</Text>
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" editable={!sent} />
      {!sent ? (
        <>
          <Text style={type.small}>We will email you an 8-character code. It works for 30 minutes.</Text>
          {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
          <Button title="Email me a code" busy={busy} disabled={!email.includes('@')} onPress={send} />
        </>
      ) : (
        <>
          <Text style={type.body}>If an account exists for that email, a code is on its way. Check your spam folder too.</Text>
          <Field label="Code from the email" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="ABCD-2345" />
          <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" hint="At least 10 characters." />
          {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
          <Button title="Change password" busy={busy} disabled={code.trim().length < 8 || password.length < 10} onPress={reset} />
          <Button title="Send a new code" kind="secondary" busy={busy} onPress={send} />
        </>
      )}
    </ScrollView>
  );
}
