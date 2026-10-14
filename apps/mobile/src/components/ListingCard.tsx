import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, ListingView, titleCase } from '../api';
import { useAuth } from '../auth';
import { useSaved } from '../saved';
import { colors, radius, space, type } from '../theme';
import { Chip } from './ui';

export function ListingCard({ item, width }: { item: ListingView; width?: number }) {
  const { user } = useAuth();
  const { ids, toggle } = useSaved();
  const saved = ids.has(item.id);
  const onSave = async () => {
    if (!user) { router.push('/login'); return; }
    try { await toggle(item.id); } catch (e) { Alert.alert('Could not update saved items', e instanceof ApiError ? e.message : 'Please try again.'); }
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}, ${item.price.label}`} onPress={() => router.push(`/listing/${item.id}`)} style={[s.card, width ? { width } : null]}>
      <View style={s.imageWrap}>
        {item.images[0] ? <Image source={{ uri: item.images[0] }} style={s.image} accessibilityIgnoresInvertColors /> : <View style={[s.image, s.noImage]}><Ionicons name="image-outline" size={28} color={colors.muted} /><Text style={type.small}>No photo</Text></View>}
        <Pressable accessibilityRole="button" accessibilityLabel={saved ? 'Remove from saved' : 'Save listing'} onPress={onSave} hitSlop={10} style={s.save}>
          <Ionicons name={saved ? 'heart' : 'heart-outline'} size={20} color={saved ? colors.danger : colors.ink} />
        </Pressable>
        {item.sponsored ? <View style={s.sponsored}><Chip label="Sponsored" tone="sponsored" /></View> : null}
      </View>
      <View style={{ padding: space.md, gap: 4 }}>
        <Text numberOfLines={2} style={s.title}>{item.title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={[s.price, item.price.isFree && { color: colors.accent }]}>{item.price.label}</Text>
          {item.dealScore ? <Chip tone="deal" label={`Deal ${item.dealScore.score}/100`} /> : null}
        </View>
        <Text numberOfLines={1} style={type.small}>{[item.distance?.label, titleCase(item.condition)].filter(Boolean).join(' · ')}</Text>
        <Text numberOfLines={1} style={[type.small, item.freshness.stale && { color: colors.caution }]}>{item.freshness.label}</Text>
        {item.risk.level !== 'NO_MAJOR_SIGNALS' ? <Chip tone="caution" label={item.risk.label} /> : null}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  imageWrap: { position: 'relative' },
  image: { width: '100%', height: 140, backgroundColor: '#E8EDEA' },
  noImage: { alignItems: 'center', justifyContent: 'center', gap: 4 },
  save: { position: 'absolute', top: 8, right: 8, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center' },
  sponsored: { position: 'absolute', top: 8, left: 8 },
  title: { fontSize: 15, fontWeight: '600', color: colors.ink },
  price: { fontSize: 17, fontWeight: '800', color: colors.ink },
});
