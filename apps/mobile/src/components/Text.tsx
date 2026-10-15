import React from 'react';
import { StyleSheet, Text as RNText, TextProps } from 'react-native';

// Custom fonts need one family name per weight, so this wrapper turns the ordinary
// fontWeight in a style into the matching font file. Use it instead of react-native's Text.
const BODY: Record<string, string> = { '400': 'DMSans_400Regular', '500': 'DMSans_500Medium', '600': 'DMSans_700Bold', '700': 'DMSans_700Bold', '800': 'DMSans_700Bold', bold: 'DMSans_700Bold', normal: 'DMSans_400Regular' };
const DISPLAY: Record<string, string> = { '400': 'BricolageGrotesque_700Bold', '500': 'BricolageGrotesque_700Bold', '600': 'BricolageGrotesque_700Bold', '700': 'BricolageGrotesque_700Bold', '800': 'BricolageGrotesque_800ExtraBold', bold: 'BricolageGrotesque_700Bold', normal: 'BricolageGrotesque_700Bold' };

export function fontFor(style: unknown): { fontFamily: string } {
  const flat = (StyleSheet.flatten(style as never) ?? {}) as { fontFamily?: string; fontWeight?: string | number };
  const w = String(flat.fontWeight ?? '400');
  return { fontFamily: (flat.fontFamily === 'display' ? DISPLAY : BODY)[w] ?? 'DMSans_400Regular' };
}

export function Text({ style, ...props }: TextProps) {
  // fontWeight is dropped after mapping so Android does not fake-bold an already bold file.
  return <RNText {...props} style={[style, fontFor(style), { fontWeight: undefined }]} />;
}
