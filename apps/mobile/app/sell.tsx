import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Image, Pressable, ScrollView, Switch, View } from 'react-native';
import { api, ApiError, CATEGORIES, CONDITIONS, ListingView, titleCase, uploadPhoto } from '../src/api';
import { useAuth } from '../src/auth';
import { Button, Chip, EmptyState, Field } from '../src/components/ui';
import { LocationBar } from '../src/components/LocationBar';
import { useLocationState } from '../src/location';
import { currencyForCountry, toMinor } from '../src/money';
import { colors, space, type } from '../src/theme';
import { Text } from '../src/components/Text';

const MAX_PHOTOS = 8;
interface Photo { id: string; uri: string; url?: string; error?: string }

export default function Sell() {
  const { user } = useAuth();
  const { place } = useLocationState();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('furniture');
  const [condition, setCondition] = useState('GOOD');
  const [quick, setQuick] = useState(true);
  const [free, setFree] = useState(true);
  const [price, setPrice] = useState('');
  const [days, setDays] = useState(14);
  const [externalUrl, setExternalUrl] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploading = photos.some((p) => !p.url && !p.error);

  const addAssets = (assets: ImagePicker.ImagePickerAsset[]) => {
    const room = MAX_PHOTOS - photos.length;
    const picked = assets.slice(0, Math.max(0, room));
    const fresh: Photo[] = picked.map((a) => ({ id: `${Date.now()}-${Math.random()}`, uri: a.uri }));
    setPhotos((cur) => [...cur, ...fresh]);
    picked.forEach((a, i) => {
      uploadPhoto(a.uri, a.mimeType)
        .then((url) => setPhotos((cur) => cur.map((p) => (p.id === fresh[i].id ? { ...p, url } : p))))
        .catch((e: ApiError) => setPhotos((cur) => cur.map((p) => (p.id === fresh[i].id ? { ...p, error: e.message } : p))));
    });
  };
  const pickFromLibrary = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: MAX_PHOTOS - photos.length, quality: 0.85 });
    if (!res.canceled) addAssets(res.assets);
  };
  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setError('Allow camera access in your phone settings to take a photo, or choose one from your library.');
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (!res.canceled) addAssets(res.assets);
  };

  if (!user) return <EmptyState title="Sign in to post" body="You need an account to list an item." action={<Button title="Sign in" onPress={() => router.replace('/login')} />} />;
  const currency = currencyForCountry(user.countryCode);

  const submit = async () => {
    setError(null);
    if (title.trim().length < 3) return setError('Add a title of at least 3 characters.');
    if (!place) return setError('Choose where the item is. We only show an approximate area to others.');
    if (!free && price.trim() && toMinor(price, currency) === null) return setError('Enter a valid price, e.g. 25 or 25.50.');
    if (!free && !price.trim()) return setError('Enter a price, or switch on "Free".');
    if (uploading) return setError('Wait for your photos to finish uploading.');
    setBusy(true);
    try {
      const l = await api<ListingView>('/listings', { body: { title: title.trim(), ...(quick ? {} : { description: description.trim() || undefined, categoryKey: category, condition }), price: free ? '0' : price.trim(), currency, lat: place.lat, lng: place.lng, locationLabel: place.label === 'Near me' ? undefined : place.label, availabilityDays: quick ? 14 : days, ...(photos.some((p) => p.url) ? { imageUrls: photos.flatMap((p) => (p.url ? [p.url] : [])) } : {}), ...(!quick && externalUrl.trim() ? { externalUrl: externalUrl.trim(), contactMethod: 'EXTERNAL_LINK' } : {}) } });
      router.replace(`/listing/${l.id}`);
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Chip label="Quick post" selected={quick} onPress={() => setQuick(true)} />
        <Chip label="Full details" selected={!quick} onPress={() => setQuick(false)} />
      </View>
      {quick ? <Text style={type.small}>Photo, title and price. That's all it takes. You can add details later.</Text> : null}
      <Field label="Title" value={title} onChangeText={setTitle} maxLength={120} placeholder="e.g. Oak desk, 120cm" />
      {!quick ? <>
      <Field label="Description" value={description} onChangeText={setDescription} multiline maxLength={5000} placeholder="Condition, size, anything the buyer should know" />
      <View style={{ gap: space.sm }}><Text style={type.label}>Category</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{CATEGORIES.map((c) => <Chip key={c} label={titleCase(c)} selected={category === c} onPress={() => setCategory(c)} />)}</View></View>
      <View style={{ gap: space.sm }}><Text style={type.label}>Condition</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{CONDITIONS.map((c) => <Chip key={c} label={titleCase(c)} selected={condition === c} onPress={() => setCondition(c)} />)}</View></View>
      </> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={type.body}>Giving it away for free</Text><Switch accessibilityLabel="Free item" value={free} onValueChange={setFree} trackColor={{ true: colors.accent, false: colors.line }} /></View>
      {!free ? <Field label={`Price (${currency})`} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="25.00" /> : null}
      <View style={{ gap: space.sm }}><Text style={type.label}>Where is the item?</Text><LocationBar /></View>
      {!quick ? <>
      <View style={{ gap: space.sm }}><Text style={type.label}>Keep listed for</Text><View style={{ flexDirection: 'row', gap: space.sm }}>{[7, 14, 30].map((d) => <Chip key={d} label={`${d} days`} selected={days === d} onPress={() => setDays(d)} />)}</View></View>
      <Field label="Original listing link (optional)" value={externalUrl} onChangeText={setExternalUrl} autoCapitalize="none" keyboardType="url" placeholder="https://…" hint="Only share links you are allowed to share. We link to the page; we do not copy it." />
      </> : null}
      <View style={{ gap: space.sm }}>
        <Text style={type.label}>Photos ({photos.length}/{MAX_PHOTOS})</Text>
        {photos.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {photos.map((p) => (
              <View key={p.id} style={{ width: 96, height: 96 }}>
                <Image source={{ uri: p.uri }} style={{ width: 96, height: 96, borderRadius: 8, backgroundColor: colors.imageBg, opacity: p.url ? 1 : 0.5 }} accessibilityIgnoresInvertColors />
                {p.error ? <Text style={[type.small, { color: colors.danger, position: 'absolute', bottom: 2, left: 4, right: 4 }]} numberOfLines={2}>{p.error}</Text> : !p.url ? <Text style={[type.small, { position: 'absolute', top: 38, alignSelf: 'center' }]}>Uploading…</Text> : null}
                <Pressable accessibilityRole="button" accessibilityLabel="Remove photo" onPress={() => setPhotos((cur) => cur.filter((x) => x.id !== p.id))} style={{ position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#fff', fontSize: 14, lineHeight: 16 }}>✕</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {photos.length < MAX_PHOTOS ? (
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}><Button title="Take photo" kind="secondary" onPress={takePhoto} /></View>
            <View style={{ flex: 1 }}><Button title="Choose photos" kind="secondary" onPress={pickFromLibrary} /></View>
          </View>
        ) : null}
        <Text style={type.small}>Photos are resized, and location data inside them is removed before they are stored.</Text>
      </View>
      <Text style={type.small}>Never ask for deposits or advance payments in a listing; those are flagged for review.</Text>
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Post item" busy={busy} disabled={uploading} onPress={submit} />
    </ScrollView>
  );
}
