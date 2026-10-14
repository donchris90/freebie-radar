import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocationState } from '../location';
import { colors, radius, space, type } from '../theme';
import { Button, Field } from './ui';

export function LocationBar() {
  const { place, busy, error, useCurrent, setManual, permission } = useLocationState();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`Location: ${place?.label ?? 'not set'}. Change`} onPress={() => setOpen(true)} style={s.pill}>
        <Ionicons name="location-outline" size={16} color={colors.ink} />
        <Text style={s.pillText} numberOfLines={1}>{place ? place.label : 'Set location'}</Text>
        <Ionicons name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <Text style={type.h2}>Where should we look?</Text>
            <Text style={[type.small, { marginTop: 4 }]}>Your location is used only to find nearby listings. We never track you in the background.</Text>
            <View style={{ gap: space.md, marginTop: space.lg }}>
              <Button title="Use my current location" busy={busy} onPress={async () => { await useCurrent(); }} />
              <Field label="Or enter a city or postcode" value={text} onChangeText={setText} placeholder="e.g. Brooklyn, NY" returnKeyType="search" onSubmitEditing={() => setManual(text)} />
              <Button title="Search this place" kind="secondary" disabled={!text.trim()} busy={busy} onPress={async () => { await setManual(text); }} />
              {permission === 'denied' ? <Text style={[type.small, { color: colors.caution }]}>Location access is turned off. Manual entry still works.</Text> : null}
              {error ? <Text accessibilityLiveRegion="polite" style={[type.small, { color: colors.danger }]}>{error}</Text> : null}
              <Button title={place ? 'Done' : 'Close'} kind="secondary" onPress={() => setOpen(false)} />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 12, minHeight: 36, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, maxWidth: 260 },
  pillText: { fontSize: 14, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,31,43,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.bg, padding: space.xl, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
});
