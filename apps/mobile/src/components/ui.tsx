import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, StyleProp, StyleSheet, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { ApiError } from '../api';
import { colors, radius, space, type } from '../theme';
import { Rings } from './Radar';
import { Text } from './Text';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export function Button({ title, onPress, kind = 'primary', disabled, busy, style, icon }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>; icon?: IconName;
}) {
  const bg = kind === 'primary' ? colors.accent : kind === 'danger' ? colors.danger : colors.surface;
  const fg = kind === 'secondary' ? colors.ink : '#fff';
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled || !!busy }} disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: disabled ? 0.45 : 1, transform: [{ scale: pressed ? 0.98 : 1 }], borderColor: kind === 'secondary' ? colors.ink : bg }, style]}>
      {busy ? <ActivityIndicator color={fg} /> : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
          <Text style={[s.buttonText, { color: fg }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, tone, icon }: { label: string; selected?: boolean; onPress?: () => void; tone?: 'free' | 'deal' | 'caution' | 'danger' | 'sponsored' | 'muted'; icon?: IconName }) {
  const t = tone === 'free' ? [colors.sticker, colors.ink] : tone === 'deal' ? [colors.ink, '#fff'] : tone === 'caution' ? [colors.cautionSoft, colors.caution]
    : tone === 'danger' ? [colors.dangerSoft, colors.danger] : tone === 'sponsored' ? [colors.sponsoredSoft, colors.sponsored] : [colors.surface, colors.ink];
  const bg = selected ? colors.ink : t[0];
  const fg = selected ? '#fff' : t[1];
  const body = (
    <View style={[s.chip, { backgroundColor: bg, borderColor: selected ? colors.ink : tone ? t[0] : colors.line }]}>
      {icon ? <Ionicons name={icon} size={14} color={fg} /> : null}
      <Text style={[s.chipText, { color: fg }]}>{label}</Text>
    </View>
  );
  return onPress ? <Pressable accessibilityRole="button" accessibilityState={{ selected: !!selected }} onPress={onPress} hitSlop={4}>{body}</Pressable> : body;
}

/** The price as a retail tag. Free is a slightly tilted yellow sticker; paid is a plain white tag. */
export function PriceTag({ label, free, size = 'sm' }: { label: string; free: boolean; size?: 'sm' | 'lg' }) {
  const big = size === 'lg';
  return (
    <View accessibilityLabel={`Price ${label}`} style={[
      s.tag, big && s.tagLg,
      free ? { backgroundColor: colors.sticker, transform: [{ rotate: '-3deg' }] } : { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
    ]}>
      <Text style={{ fontFamily: 'display', fontWeight: '800', fontSize: big ? 24 : 16, color: colors.ink, letterSpacing: -0.3 }}>{free ? 'Free' : label}</Text>
    </View>
  );
}

/** Deal Score as a dark disc. Only rendered when a score exists. */
export function DealBadge({ score, size = 40 }: { score: number; size?: number }) {
  return (
    <View accessibilityLabel={`Deal Score ${score} out of 100`} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: 'display', fontWeight: '800', fontSize: size * 0.42, color: '#fff' }}>{score}</Text>
    </View>
  );
}

export function Panel({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg }, style]}>{children}</View>;
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  // Password fields get a show/hide button so people can check what they typed.
  const isSecret = !!props.secureTextEntry;
  const [shown, setShown] = React.useState(false);
  const input = (
    <TextInput accessibilityLabel={label} placeholderTextColor={colors.placeholder} {...props} secureTextEntry={isSecret && !shown} autoCorrect={isSecret ? false : props.autoCorrect} spellCheck={isSecret ? false : props.spellCheck} style={[s.input, props.multiline && { minHeight: 96, textAlignVertical: 'top', paddingTop: 12 }, isSecret && { paddingRight: 52 }, props.style]} />
  );
  return (
    <View style={{ gap: 6 }}>
      <Text style={type.label}>{label}</Text>
      {isSecret ? (
        <View>
          {input}
          <Pressable accessibilityRole="button" accessibilityLabel={shown ? 'Hide password' : 'Show password'} hitSlop={8} onPress={() => setShown((v) => !v)} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name={shown ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.muted} />
          </Pressable>
        </View>
      ) : input}
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
      <Ionicons name={offline ? 'cloud-offline-outline' : 'alert-circle-outline'} size={36} color={colors.muted} />
      <Text style={[type.h2, { textAlign: 'center', marginTop: 8 }]}>{offline ? "You're offline" : 'Something went wrong'}</Text>
      <Text style={[type.body, { textAlign: 'center', marginVertical: 8, color: colors.muted }]}>{error.message}</Text>
      {onRetry ? <Button title="Try again" kind="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function EmptyState({ title, body, action, icon }: { title: string; body?: string; action?: React.ReactNode; icon?: IconName }) {
  return (
    <View style={s.center}>
      <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center', marginBottom: space.md }}>
        <Rings size={120} count={3} color="rgba(47,43,230,0.18)" />
        {icon ? <Ionicons name={icon} size={26} color={colors.accent} style={{ position: 'absolute' }} /> : null}
      </View>
      <Text style={[type.h2, { textAlign: 'center' }]}>{title}</Text>
      {body ? <Text style={[type.body, { textAlign: 'center', marginVertical: 8, color: colors.muted, maxWidth: 320 }]}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={{ marginTop: space.xl + 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: space.lg, marginBottom: space.md }}>
        <Text accessibilityRole="header" style={type.h2}>{title}</Text>{right}
      </View>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  button: { minHeight: 50, borderRadius: radius.pill, paddingHorizontal: space.xl, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '700' },
  tag: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, alignSelf: 'flex-start' },
  tagLg: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12 },
  input: { minHeight: 50, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 16, color: colors.ink, fontFamily: 'DMSans_400Regular' },
  center: { alignItems: 'center', justifyContent: 'center', padding: space.xl },
});
