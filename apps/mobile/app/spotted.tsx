import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { api, ApiError, ListingView, uploadPhoto } from '../src/api';
import { useAuth } from '../src/auth';
import { LocationBar } from '../src/components/LocationBar';
import { Text } from '../src/components/Text';
import { Button, EmptyState, Field } from '../src/components/ui';
import { useLocationState } from '../src/location';
import { colors, space, type } from '../src/theme';

/** Report something free you saw outside (a curb find). Photo and pin are required; it expires on its own. */
export default function Spotted() {
  const { user } = useAuth();
  const { place } = useLocationState();
  const [title, setTitle] = useState('');
  const [photo, setPhoto] = useState<{ uri: string; url?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return <EmptyState title="Sign in to share a find" action={<Button title="Sign in" onPress={() => router.replace('/login')} />} />;

  const add = (a: ImagePicker.ImagePickerAsset) => {
    setPhoto({ uri: a.uri });
    uploadPhoto(a.uri, a.mimeType).then((url) => setPhoto((p) => (p && p.uri === a.uri ? { ...p, url } : p))).catch((e: ApiError) => setPhoto((p) => (p && p.uri === a.uri ? { ...p, error: e.message } : p)));
  };
  const take = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setError('Allow camera access in your phone settings, or choose a photo from your library.');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (!r.canceled) add(r.assets[0]);
  };
  const choose = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (!r.canceled) add(r.assets[0]);
  };
  const submit = async () => {
    setError(null);
    if (!photo?.url) return setError(photo ? 'Wait for the photo to finish uploading.' : 'Add a photo so others can recognise it.');
    if (title.trim().length < 3) return setError('Say what it is, e.g. "Armchair by the bins".');
    if (!place) return setError('Set where you saw it. Others only see an approximate area.');
    setBusy(true);
    try {
      const l = await api<ListingView>('/listings/spotted', { body: { title: title.trim(), lat: place.lat, lng: place.lng, locationLabel: place.label === 'Near me' ? undefined : place.label, imageUrls: [photo.url] } });
      router.replace(`/listing/${l.id}`);
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Text style={type.body}>Saw something free on the curb? Share it so a neighbour can grab it. It disappears on its own after a day.</Text>
      {photo ? <Image source={{ uri: photo.uri }} style={{ width: '100%', height: 220, borderRadius: 12, backgroundColor: colors.imageBg, opacity: photo.url ? 1 : 0.5 }} accessibilityIgnoresInvertColors /> : null}
      {photo?.error ? <Text style={[type.small, { color: colors.danger }]}>{photo.error}</Text> : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}><Button title={photo ? 'Retake' : 'Take photo'} kind="secondary" onPress={take} /></View>
        <View style={{ flex: 1 }}><Button title="Choose photo" kind="secondary" onPress={choose} /></View>
      </View>
      <Field label="What is it?" value={title} onChangeText={setTitle} maxLength={120} placeholder="e.g. Armchair on the curb" />
      <View style={{ gap: space.sm }}><Text style={type.label}>Where did you see it?</Text><LocationBar /></View>
      <Text style={type.small}>Only share items that are clearly being given away, and never from private property. Do not include people in the photo.</Text>
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="Share this find" busy={busy} disabled={!!photo && !photo.url && !photo.error} onPress={submit} />
    </ScrollView>
  );
}
