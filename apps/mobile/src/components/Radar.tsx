import React from 'react';
import { View } from 'react-native';

/** Concentric rings, the app's one recurring graphic. Plain Views, no image or SVG dependency. */
export function Rings({ size = 320, color = 'rgba(255,255,255,0.14)', count = 4, style }: { size?: number; color?: string; count?: number; style?: object }) {
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
      {Array.from({ length: count }, (_, i) => {
        const d = size * ((i + 1) / count);
        return <View key={i} style={{ position: 'absolute', width: d, height: d, borderRadius: d / 2, borderWidth: 1.5, borderColor: color }} />;
      })}
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#FFD23F' }} />
    </View>
  );
}

/** Small brand mark: rings with a sticker-yellow blip. */
export function Mark({ size = 28, ring = '#FFFFFF' }: { size?: number; ring?: string }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 2.5, borderColor: ring }} />
      <View style={{ position: 'absolute', width: size * 0.55, height: size * 0.55, borderRadius: size, borderWidth: 2.5, borderColor: ring, opacity: 0.7 }} />
      <View style={{ width: size * 0.22, height: size * 0.22, borderRadius: size, backgroundColor: '#FFD23F' }} />
    </View>
  );
}
