import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Alert, Image, Pressable, StyleSheet, View } from 'react-native';
import { ApiError, ListingView, titleCase } from '../api';
import { useAuth } from '../auth';
import { useSaved } from '../saved';
import { colors, radius, shadow, space, type } from '../theme';
import { Text } from './Text';
import { Chip, DealBadge, PriceTag } from './ui';

export function ListingCard({ item, width }: { item: ListingView; width?: number }) {
  const { user } = useAuth();
  const { ids, toggle } = useSaved();
  const saved = ids.has(item.id);
  const onSave = async () => {
    if (!user) { router.push('/login'); return; }
    try { await toggle(item.id); } catch (e) { Alert.alert('Could not update saved items', e instanceof ApiError ? e.message : 'Please try again.'); }
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}, ${item.price.label}`} onPress={() => router.push(`/listing/${item.id}`)} style={({ pressed }) => [s.card, shadow.card, width ? { width } : null, pressed && { transform: [{ scale: 0.99 }] }]}>
      <View>
        {item.images[0] ? <Image source={{ uri: item.images[0] }} style={s.image} accessibilityIgnoresInvertColors /> : <View style={[s.image, s.noImage]}><Ionicons name="image-outline" size={28} color={colors.muted} /><Text style={type.small}>No photo</Text></View>}
        <Pressable accessibilityRole="button" accessibilityLabel={saved ? 'Remove from saved' : 'Save listing'} onPress={onSave} hitSlop={10} style={s.save}>
          <Ionicons name={saved ? 'heart' : 'heart-outline'} size={20} color={saved ? colors.danger : colors.ink} />
        </Pressable>
        <View style={s.priceWrap}><PriceTag label={item.price.label} free={item.price.isFree} /></View>
        {item.dealScore ? <View style={s.deal}><DealBadge score={item.dealScore.score} /></View> : null}
      </View>
      <View style={{ padding: space.md, gap: 4 }}>
        <Text numberOfLines={2} style={s.title}>{item.title}</Text>
        <Text numberOfLines={1} style={type.small}>{[item.distance?.label, titleCase(item.condition)].filter(Boolean).join(' · ')}</Text>
        <Text numberOfLines={1} style={[type.small, item.freshness.stale && { color: colors.caution }]}>{item.freshness.label}</Text>
        {item.sponsored || item.risk.level !== 'NO_MAJOR_SIGNALS' ? (
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {item.sponsored ? <Chip label="Sponsored" tone="sponsored" /> : null}
            {item.risk.level !== 'NO_MAJOR_SIGNALS' ? <Chip tone="caution" label={item.risk.label} /> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  image: { width: '100%', height: 160, backgroundColor: colors.imageBg },
  noImage: { alignItems: 'center', justifyContent: 'center', gap: 4 },
  save: { position: 'absolute', top: 10, right: 10, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.96)', alignItems: 'center', justifyContent: 'center' },
  priceWrap: { position: 'absolute', left: 10, bottom: 10 },
  deal: { position: 'absolute', top: 10, left: 10 },
  title: { fontSize: 16, fontWeight: '700', color: colors.ink, lineHeight: 21 },
});
