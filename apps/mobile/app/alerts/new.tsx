import { router } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { api, ApiError, CATEGORIES, titleCase } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Button, Chip, EmptyState, Field } from '../../src/components/ui';
import { useLocationState } from '../../src/location';
import { currencyForCountry, toMinor } from '../../src/money';
import { colors, space, type } from '../../src/theme';

const FREQ = [['IMMEDIATE', 'Immediately'], ['HOURLY_DIGEST', 'Hourly digest'], ['DAILY_DIGEST', 'Daily digest']] as const;

export default function NewAlert() {
  const { user } = useAuth();
  const { place } = useLocationState();
  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [excluded, setExcluded] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [radius, setRadius] = useState('');
  const [minScore, setMinScore] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [freq, setFreq] = useState<(typeof FREQ)[number][0]>('IMMEDIATE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user) return <EmptyState title="Sign in to create alerts" action={<Button title="Sign in" onPress={() => router.replace('/login')} />} />;

  const currency = currencyForCountry(user.countryCode);
  const unit = user.prefs.distanceUnit;
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

  const submit = async () => {
    setError(null);
    const max = maxPrice ? toMinor(maxPrice, currency) : undefined;
    if (maxPrice && max === null) return setError('Enter a valid maximum price, e.g. 250');
    const r = radius ? Number(radius) : undefined;
    if (radius && (!Number.isFinite(r) || (r as number) <= 0)) return setError('Enter a valid distance');
    if (r && !place) return setError('Set your location on the Discover tab first, so we know where to measure from.');
    const score = minScore ? Number(minScore) : undefined;
    if (minScore && (!Number.isInteger(score) || (score as number) < 0 || (score as number) > 100)) return setError('Deal Score must be a whole number from 0 to 100');
    setBusy(true);
    try {
      await api('/alerts', { body: {
        name: name.trim() || list(keywords)[0] || 'My alert',
        keywords: list(keywords), excludedWords: list(excluded), categories, freeOnly,
        ...(max !== undefined && max !== null ? { maxPriceMinor: max, currency } : {}),
        ...(r && place ? { radiusKm: unit === 'mi' ? r * 1.609344 : r, centerLat: place.lat, centerLng: place.lng } : {}),
        ...(score !== undefined ? { minDealScore: score } : {}),
        frequency: freq,
      } });
      router.back();
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Alert name" value={name} onChangeText={setName} placeholder="MacBook under 250" />
      <Field label="Keywords (any of, comma separated)" value={keywords} onChangeText={setKeywords} placeholder="macbook, thinkpad" autoCapitalize="none" />
      <Field label="Exclude words" value={excluded} onChangeText={setExcluded} placeholder="broken, parts" autoCapitalize="none" />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={type.body}>Free items only</Text><Switch value={freeOnly} onValueChange={setFreeOnly} trackColor={{ true: colors.accent }} accessibilityLabel="Free items only" /></View>
      <Field label={`Max price (${currency})`} value={maxPrice} onChangeText={setMaxPrice} keyboardType="decimal-pad" placeholder="Any" />
      <Field label={`Distance (${unit})`} value={radius} onChangeText={setRadius} keyboardType="decimal-pad" placeholder="Anywhere" hint={place ? `Measured from ${place.label}` : 'Needs a location. Set one on the Discover tab.'} />
      <Field label="Minimum Deal Score (0–100)" value={minScore} onChangeText={setMinScore} keyboardType="number-pad" placeholder="Any" hint="Only listings with enough comparable evidence have a score." />
      <View style={{ gap: space.sm }}><Text style={type.label}>Categories</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{CATEGORIES.map((c) => <Chip key={c} label={titleCase(c)} selected={categories.includes(c)} onPress={() => setCategories((s) => s.includes(c) ? s.filter((x) => x !== c) : [...s, c])} />)}</View></View>
      <View style={{ gap: space.sm }}><Text style={type.label}>Delivery</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{FREQ.map(([k, l]) => <Chip key={k} label={l} selected={freq === k} onPress={() => setFreq(k)} />)}</View></View>
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Create alert" busy={busy} onPress={submit} />
    </ScrollView>
  );
}
