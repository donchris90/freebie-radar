import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';
import { api, ApiError, CATEGORIES, ListingView, Page, titleCase } from '../src/api';
import { useAuth } from '../src/auth';
import { ListingCard } from '../src/components/ListingCard';
import { Button, Chip, EmptyState, ErrorState, Field, LoadingState } from '../src/components/ui';
import { useLocationState } from '../src/location';
import { currencyForCountry, toMinor } from '../src/money';
import { space, type } from '../src/theme';

export default function Search() {
  const params = useLocalSearchParams<{ q?: string; category?: string; freeOnly?: string }>();
  const { user } = useAuth();
  const { place } = useLocationState();
  const unit = user?.prefs.distanceUnit ?? 'km';
  const currency = currencyForCountry(user?.countryCode);
  const [q, setQ] = useState(params.q ?? '');
  const [category, setCategory] = useState<string | undefined>(params.category);
  const [freeOnly, setFreeOnly] = useState(params.freeOnly === '1');
  const [maxPrice, setMaxPrice] = useState('');
  const [radius, setRadius] = useState<number | undefined>(undefined);
  const [items, setItems] = useState<ListingView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const priceInvalid = maxPrice !== '' && toMinor(maxPrice, currency) === null;

  const load = useCallback(async (next?: string | null) => {
    if (priceInvalid) return;
    next ? setMore(true) : setLoading(true);
    setError(null);
    try {
      const page = await api<Page<ListingView>>('/listings', { query: { q: q || undefined, category, freeOnly: freeOnly || undefined, maxPrice: maxPrice || undefined, currency: maxPrice ? currency : undefined, ...(place ? { lat: place.lat, lng: place.lng } : {}), radius: place ? radius : undefined, unit, cursor: next ?? undefined, limit: 20 } });
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor); setTotal(page.total);
    } catch (e) { setError(e as ApiError); }
    finally { setLoading(false); setMore(false); }
  }, [q, category, freeOnly, maxPrice, radius, place?.lat, place?.lng, unit, currency, priceInvalid]);

  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);

  return (
    <FlatList
      data={items} keyExtractor={(i) => i.id} contentContainerStyle={{ padding: space.lg, gap: space.md }}
      ListHeaderComponent={
        <View style={{ gap: space.md, marginBottom: space.sm }}>
          <Field label="Search" value={q} onChangeText={setQ} placeholder="e.g. desk, MacBook, pram" returnKeyType="search" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            <Chip label="Free only" selected={freeOnly} onPress={() => setFreeOnly(!freeOnly)} />
            {[5, 10, 25].map((r) => <Chip key={r} label={`${r} ${unit}`} selected={radius === r} onPress={() => setRadius(radius === r ? undefined : r)} />)}
            {CATEGORIES.map((c) => <Chip key={c} label={titleCase(c)} selected={category === c} onPress={() => setCategory(category === c ? undefined : c)} />)}
          </ScrollView>
          <Field label={`Max price (${currency})`} value={maxPrice} onChangeText={setMaxPrice} keyboardType="decimal-pad" placeholder="Any" hint={priceInvalid ? 'Enter a valid amount, e.g. 25 or 25.50' : undefined} />
          {radius && !place ? <Text style={[type.small, { color: '#8A5A00' }]}>Set a location on the Discover tab to filter by distance.</Text> : null}
          {!loading && !error ? <Text style={type.small}>{total} result{total === 1 ? '' : 's'}</Text> : null}
        </View>
      }
      renderItem={({ item }) => <ListingCard item={item} />}
      ListEmptyComponent={loading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={() => load()} /> : <EmptyState title="No matches" body="Try removing a filter or searching a different word." />}
      ListFooterComponent={cursor ? <Button title="Load more" kind="secondary" busy={more} onPress={() => load(cursor)} /> : null}
    />
  );
}
