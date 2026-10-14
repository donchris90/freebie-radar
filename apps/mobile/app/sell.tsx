import { router } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { api, ApiError, CATEGORIES, CONDITIONS, ListingView, titleCase } from '../src/api';
import { useAuth } from '../src/auth';
import { Button, Chip, EmptyState, Field } from '../src/components/ui';
import { LocationBar } from '../src/components/LocationBar';
import { useLocationState } from '../src/location';
import { currencyForCountry, toMinor } from '../src/money';
import { colors, space, type } from '../src/theme';

export default function Sell() {
  const { user } = useAuth();
  const { place } = useLocationState();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('furniture');
  const [condition, setCondition] = useState('GOOD');
  const [free, setFree] = useState(false);
  const [price, setPrice] = useState('');
  const [days, setDays] = useState(14);
  const [externalUrl, setExternalUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user) return <EmptyState title="Sign in to post" body="You need an account to list an item." action={<Button title="Sign in" onPress={() => router.replace('/login')} />} />;
  const currency = currencyForCountry(user.countryCode);

  const submit = async () => {
    setError(null);
    if (title.trim().length < 3) return setError('Add a title of at least 3 characters.');
    if (!place) return setError('Choose where the item is. We only show an approximate area to others.');
    if (!free && price.trim() && toMinor(price, currency) === null) return setError('Enter a valid price, e.g. 25 or 25.50.');
    if (!free && !price.trim()) return setError('Enter a price, or switch on "Free".');
    setBusy(true);
    try {
      const l = await api<ListingView>('/listings', { body: { title: title.trim(), description: description.trim() || undefined, categoryKey: category, condition, price: free ? '0' : price.trim(), currency, lat: place.lat, lng: place.lng, locationLabel: place.label === 'Near me' ? undefined : place.label, availabilityDays: days, ...(externalUrl.trim() ? { externalUrl: externalUrl.trim(), contactMethod: 'EXTERNAL_LINK' } : {}) } });
      router.replace(`/listing/${l.id}`);
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Title" value={title} onChangeText={setTitle} maxLength={120} placeholder="e.g. Oak desk, 120cm" />
      <Field label="Description" value={description} onChangeText={setDescription} multiline maxLength={5000} placeholder="Condition, size, anything the buyer should know" />
      <View style={{ gap: space.sm }}><Text style={type.label}>Category</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{CATEGORIES.map((c) => <Chip key={c} label={titleCase(c)} selected={category === c} onPress={() => setCategory(c)} />)}</View></View>
      <View style={{ gap: space.sm }}><Text style={type.label}>Condition</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{CONDITIONS.map((c) => <Chip key={c} label={titleCase(c)} selected={condition === c} onPress={() => setCondition(c)} />)}</View></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={type.body}>Giving it away for free</Text><Switch accessibilityLabel="Free item" value={free} onValueChange={setFree} trackColor={{ true: colors.accent }} /></View>
      {!free ? <Field label={`Price (${currency})`} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="25.00" /> : null}
      <View style={{ gap: space.sm }}><Text style={type.label}>Where is the item?</Text><LocationBar /></View>
      <View style={{ gap: space.sm }}><Text style={type.label}>Keep listed for</Text><View style={{ flexDirection: 'row', gap: space.sm }}>{[7, 14, 30].map((d) => <Chip key={d} label={`${d} days`} selected={days === d} onPress={() => setDays(d)} />)}</View></View>
      <Field label="Original listing link (optional)" value={externalUrl} onChangeText={setExternalUrl} autoCapitalize="none" keyboardType="url" placeholder="https://…" hint="Only share links you are allowed to share. We link to the page; we do not copy it." />
      <Text style={type.small}>Photo upload is not available yet. Never ask for deposits or advance payments in a listing; those are flagged for review.</Text>
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Post item" busy={busy} onPress={submit} />
    </ScrollView>
  );
}
