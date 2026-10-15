import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { colors } from '../../src/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const Icon = ({ name, color, size }: { name: IconName; color: unknown; size: number }) => <Ionicons name={name} size={size} color={color as string} />;

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{
      headerShown: false, tabBarActiveTintColor: colors.accent, tabBarInactiveTintColor: colors.muted,
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line, borderTopWidth: 1, height: 64, paddingTop: 6, paddingBottom: 8 },
      tabBarLabelStyle: { fontSize: 12, fontFamily: 'DMSans_700Bold' },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Discover', tabBarIcon: ({ color, focused, size }) => <Icon name={focused ? 'radio' : 'radio-outline'} color={color} size={size} /> }} />
      <Tabs.Screen name="map" options={{ title: 'Map', tabBarIcon: ({ color, focused, size }) => <Icon name={focused ? 'map' : 'map-outline'} color={color} size={size} /> }} />
      <Tabs.Screen name="alerts" options={{ title: 'Alerts', tabBarIcon: ({ color, focused, size }) => <Icon name={focused ? 'notifications' : 'notifications-outline'} color={color} size={size} /> }} />
      <Tabs.Screen name="saved" options={{ title: 'Saved', tabBarIcon: ({ color, focused, size }) => <Icon name={focused ? 'heart' : 'heart-outline'} color={color} size={size} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ color, focused, size }) => <Icon name={focused ? 'person' : 'person-outline'} color={color} size={size} /> }} />
    </Tabs>
  );
}
