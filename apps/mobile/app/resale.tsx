import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { api, ApiError } from '../src/api';
import { useAuth } from '../src/auth';
import { Button, Field } from '../src/components/ui';
import { currencyForCountry } from '../src/money';
import { colors, radius, space, type } from '../src/theme';
import { Text } from '../src/components/Text';

interface Result { currency: string; totalAcquisitionCostMinor: number; sellingFeesMinor: number; grossProfitMinor: number; netProfitMinor: number; marginBasisPoints: number | null; breakEvenResaleMinor: number | null; disclaimer: string }

export default function Resale() {
  const params = useLocalSearchParams<{ purchase?: string; currency?: string }>();
  const { user } = useAuth();
  const currency = params.currency ?? currencyForCountry(user?.countryCode);
  const [f, setF] = useState({ purchase: params.purchase ?? '', resale: '', transport: '', repair: '', other: '', feePercent: '', feeFixed: '', label: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (m: number) => (m / 10 ** (new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2)).toLocaleString(undefined, { style: 'currency', currency });

  const body = () => ({ currency, purchase: f.purchase || '0', resale: f.resale || '0', transport: f.transport || undefined, repair: f.repair || undefined, other: f.other || undefined, feePercent: f.feePercent || undefined, feeFixed: f.feeFixed || undefined });
  useEffect(() => {
    if (!f.resale) { setResult(null); setError(null); return; }
    const t = setTimeout(async () => {
      try { setResult(await api<Result>('/resale/calculate', { body: body() })); setError(null); }
      catch (e) { setResult(null); setError((e as ApiError).message); }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.purchase, f.resale, f.transport, f.repair, f.other, f.feePercent, f.feeFixed]);

  const save = async () => {
    if (!user) return Alert.alert('Sign in to save calculations');
    if (!f.label.trim()) return Alert.alert('Add a label so you can compare later');
    try { await api('/resale', { body: { ...body(), label: f.label.trim() } }); Alert.alert('Saved'); } catch (e) { Alert.alert('Could not save', (e as ApiError).message); }
  };
  const net = result?.netProfitMinor ?? 0;

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
      <Text style={type.small}>Amounts in {currency}. Enter what you expect to pay, spend and sell for.</Text>
      <Field label="Purchase price" value={f.purchase} onChangeText={set('purchase')} keyboardType="decimal-pad" placeholder="0" />
      <Field label="Estimated resale price" value={f.resale} onChangeText={set('resale')} keyboardType="decimal-pad" placeholder="0" hint="Not a promise: you may not achieve this price." />
      <Field label="Transport cost" value={f.transport} onChangeText={set('transport')} keyboardType="decimal-pad" />
      <Field label="Repair cost" value={f.repair} onChangeText={set('repair')} keyboardType="decimal-pad" />
      <Field label="Other expenses" value={f.other} onChangeText={set('other')} keyboardType="decimal-pad" />
      <Field label="Selling fee (% of resale price)" value={f.feePercent} onChangeText={set('feePercent')} keyboardType="decimal-pad" placeholder="e.g. 12.5" hint="Check the fees of the platform you plan to sell on." />
      <Field label="Fixed fee per sale" value={f.feeFixed} onChangeText={set('feeFixed')} keyboardType="decimal-pad" />
      {error ? <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.danger }]}>{error}</Text> : null}
      {result ? (
        <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: 6 }} accessibilityLiveRegion="polite">
          <Text style={type.label}>Estimated net profit</Text>
          <Text style={{ fontSize: 30, fontWeight: '800', color: net >= 0 ? colors.accent : colors.danger }}>{net < 0 ? '−' : ''}{money(Math.abs(net))}</Text>
          <Text style={type.body}>Total cost: {money(result.totalAcquisitionCostMinor)}</Text>
          <Text style={type.body}>Gross profit: {result.grossProfitMinor < 0 ? '−' : ''}{money(Math.abs(result.grossProfitMinor))}</Text>
          <Text style={type.body}>Selling fees: {money(result.sellingFeesMinor)}</Text>
          <Text style={type.body}>Margin: {result.marginBasisPoints === null ? 'n/a' : `${(result.marginBasisPoints / 100).toFixed(1)}%`}</Text>
          <Text style={type.body}>Break-even resale price: {result.breakEvenResaleMinor === null ? 'not reachable with these fees' : money(result.breakEvenResaleMinor)}</Text>
          <Text style={[type.small, { marginTop: 6 }]}>{result.disclaimer}</Text>
        </View>
      ) : null}
      {result && user ? <><Field label="Label (to save and compare)" value={f.label} onChangeText={set('label')} placeholder="Oak desk" /><Button title="Save calculation" kind="secondary" onPress={save} /></> : null}
    </ScrollView>
  );
}
