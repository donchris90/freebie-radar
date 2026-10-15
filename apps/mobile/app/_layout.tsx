import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { AuthProvider } from '../src/auth';
import { LocationProvider } from '../src/location';
import { SavedProvider } from '../src/saved';
import { colors } from '../src/theme';

export default function RootLayout() {
  return (
    <AuthProvider>
      <LocationProvider>
        <SavedProvider>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.ink, headerShadowVisible: false, contentStyle: { backgroundColor: colors.bg } }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="listing/[id]" options={{ title: 'Listing' }} />
            <Stack.Screen name="search" options={{ title: 'Search' }} />
            <Stack.Screen name="sell" options={{ title: 'Post an item' }} />
            <Stack.Screen name="resale" options={{ title: 'Resale calculator' }} />
            <Stack.Screen name="alerts/new" options={{ title: 'New alert' }} />
            <Stack.Screen name="my-listings" options={{ title: 'My listings' }} />
            <Stack.Screen name="login" options={{ title: 'Sign in', presentation: 'modal' }} />
            <Stack.Screen name="register" options={{ title: 'Create account', presentation: 'modal' }} />
          </Stack>
        </SavedProvider>
      </LocationProvider>
    </AuthProvider>
  );
}
