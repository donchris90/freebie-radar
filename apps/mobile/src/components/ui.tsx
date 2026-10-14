import React from 'react';
import { ActivityIndicator, Pressable, StyleProp, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { ApiError } from '../api';
import { colors, radius, space, type } from '../theme';

export function Button({ title, onPress, kind = 'primary', disabled, busy, style }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const bg = kind === 'primary' ? colors.accent : kind === 'danger' ? colors.danger : colors.surface;
  const fg = kind === 'secondary' ? colors.ink : '#fff';
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled || !!busy }} disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1, borderColor: kind === 'secondary' ? colors.line : bg }, style]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, tone }: { label: string; selected?: boolean; onPress?: () => void; tone?: 'free' | 'deal' | 'caution' | 'danger' | 'sponsored' | 'muted' }) {
  const t = tone === 'free' ? [colors.accentSoft, colors.accent] : tone === 'deal' ? [colors.dealSoft, colors.deal] : tone === 'caution' ? [colors.cautionSoft, colors.caution]
    : tone === 'danger' ? [colors.dangerSoft, colors.danger] : tone === 'sponsored' ? [colors.sponsoredSoft, colors.sponsored] : [colors.surface, colors.muted];
  const bg = selected ? colors.ink : t[0];
  const fg = selected ? '#fff' : t[1];
  const body = <View style={[s.chip, { backgroundColor: bg, borderColor: selected ? colors.ink : tone ? t[0] : colors.line }]}><Text style={[s.chipText, { color: fg }]}>{label}</Text></View>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityState={{ selected: !!selected }} onPress={onPress}>{body}</Pressable> : body;
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={type.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor="#7A8791" {...props} style={[s.input, props.multiline && { minHeight: 90, textAlignVertical: 'top' }, props.style]} />
      {hint ? <Text style={type.small}>{hint}</Text> : null}
    </View>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <View style={s.center} accessibilityLiveRegion="polite"><ActivityIndicator color={colors.accent} /><Text style={[type.small, { marginTop: 8 }]}>{label}</Text></View>;
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const offline = error instanceof ApiError && error.offline;
  return (
    <View style={s.center} accessibilityLiveRegion="polite">
      <Text style={[type.h2, { textAlign: 'center' }]}>{offline ? "You're offline" : 'Something went wrong'}</Text>
      <Text style={[type.body, { textAlign: 'center', marginVertical: 8, color: colors.muted }]}>{error.message}</Text>
      {onRetry ? <Button title="Try again" kind="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <View style={s.center}>
      <Text style={[type.h2, { textAlign: 'center' }]}>{title}</Text>
      {body ? <Text style={[type.body, { textAlign: 'center', marginVertical: 8, color: colors.muted }]}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={{ marginTop: space.xl }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: space.lg, marginBottom: space.sm }}>
        <Text accessibilityRole="header" style={type.h2}>{title}</Text>{right}
      </View>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  button: { minHeight: 48, borderRadius: radius.md, paddingHorizontal: space.lg, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '600' },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 16, color: colors.ink },
  center: { alignItems: 'center', justifyContent: 'center', padding: space.xl },
});
