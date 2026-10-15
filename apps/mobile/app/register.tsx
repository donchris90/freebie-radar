import { Link, router } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { ApiError } from '../src/api';
import { useAuth } from '../src/auth';
import { Button, Field } from '../src/components/ui';
import { colors, space, type } from '../src/theme';

export default function Register() {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState('US');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await register(email.trim(), password, name.trim(), country.trim().toUpperCase()); router.back(); } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Display name" value={name} onChangeText={setName} />
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" hint="At least 10 characters." />
      <Field label="Country code" value={country} onChangeText={setCountry} autoCapitalize="characters" maxLength={2} hint="Sets your currency and default distance unit, e.g. US, GB, CA, AU." />
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Create account" busy={busy} disabled={!name || !email || password.length < 10} onPress={submit} />
      <Link href="/login" replace style={[type.body, { color: colors.accent, textAlign: 'center' }]}>Already have an account? Sign in</Link>
    </ScrollView>
  );
}
