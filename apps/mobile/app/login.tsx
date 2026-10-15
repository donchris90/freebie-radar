import { Link, router } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView } from 'react-native';
import { ApiError } from '../src/api';
import { useAuth } from '../src/auth';
import { Button, Field } from '../src/components/ui';
import { colors, space, type } from '../src/theme';
import { Text } from '../src/components/Text';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await login(email.trim(), password); router.back(); } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" />
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Sign in" busy={busy} disabled={!email || !password} onPress={submit} />
      <Link href="/forgot-password" style={[type.body, { color: colors.accent, textAlign: 'center', fontFamily: 'DMSans_700Bold' }]}>Forgot your password?</Link>
      <Link href="/register" replace style={[type.body, { color: colors.accent, textAlign: 'center', fontFamily: 'DMSans_700Bold' }]}>New here? Create an account</Link>
    </ScrollView>
  );
}
