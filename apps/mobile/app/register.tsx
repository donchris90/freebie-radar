import { Link, router } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api, ApiError } from '../src/api';
import { useAuth } from '../src/auth';
import { Button, Chip, Field } from '../src/components/ui';
import { colors, space, type } from '../src/theme';
import { useAsync } from '../src/useAsync';
import { Text } from '../src/components/Text';

interface Country { code: string; name: string; currency: string; distanceUnit: string }

export default function Register() {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState<string | null>(null);
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countries = useAsync(() => api<{ items: Country[] }>('/countries'), []);
  const options = countries.data?.items ?? [];
  const selected = country ?? options[0]?.code ?? null;
  const submit = async () => {
    setBusy(true); setError(null);
    try { await register(email.trim(), password, name.trim(), selected ?? undefined, invite.trim() || undefined); router.back(); } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Display name" value={name} onChangeText={setName} />
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" hint="At least 10 characters." />
      <View style={{ gap: space.sm }}>
        <Text style={type.h2}>Country</Text>
        <Text style={type.small}>Sets your currency and distance unit. Only countries that are currently open are shown.</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {options.map((c) => <Chip key={c.code} label={`${c.name} · ${c.currency}`} selected={selected === c.code} onPress={() => setCountry(c.code)} />)}
        </View>
        {countries.error ? <Text style={[type.small, { color: colors.danger }]}>Could not load countries. Check your connection and try again.</Text> : null}
      </View>
      <Field label="Invite code (optional)" value={invite} onChangeText={(t) => setInvite(t.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} autoCapitalize="characters" maxLength={20} hint="From a friend or a Freebie Radar ambassador. It's fine to leave this empty." />
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Create account" busy={busy} disabled={!name || !email || password.length < 10 || !selected || (invite.length > 0 && invite.length < 4)} onPress={submit} />
      <Link href="/login" replace style={[type.body, { color: colors.accent, textAlign: 'center', fontFamily: 'DMSans_700Bold' }]}>Already have an account? Sign in</Link>
    </ScrollView>
  );
}
