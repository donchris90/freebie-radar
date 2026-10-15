import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque';
import { DMSans_400Regular, DMSans_500Medium, DMSans_700Bold, useFonts } from '@expo-google-fonts/dm-sans';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { View } from 'react-native';
import { AuthProvider } from '../src/auth';
import { LocationProvider } from '../src/location';
import { SavedProvider } from '../src/saved';
import { colors } from '../src/theme';

export default function RootLayout() {
  const [loaded, fontError] = useFonts({ DMSans_400Regular, DMSans_500Medium, DMSans_700Bold, BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });
  // Hold the first frame until fonts are ready so text never jumps from system font to ours.
  // If loading fails, carry on with system fonts rather than a blank screen.
  if (!loaded && !fontError) return <View style={{ flex: 1, backgroundColor: colors.accent }} />;
  return (
    <AuthProvider>
      <LocationProvider>
        <SavedProvider>
          <StatusBar style="dark" />
          <Stack screenOptions={{
            headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.ink, headerShadowVisible: false, contentStyle: { backgroundColor: colors.bg },
            headerTitleStyle: { fontFamily: 'BricolageGrotesque_700Bold', fontSize: 18, color: colors.ink },
          }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="listing/[id]" options={{ title: '' }} />
            <Stack.Screen name="search" options={{ title: 'Search' }} />
            <Stack.Screen name="sell" options={{ title: 'Post an item' }} />
            <Stack.Screen name="resale" options={{ title: 'Resale calculator' }} />
            <Stack.Screen name="alerts/new" options={{ title: 'New alert' }} />
            <Stack.Screen name="my-listings" options={{ title: 'My listings' }} />
            <Stack.Screen name="login" options={{ title: 'Sign in', presentation: 'modal' }} />
            <Stack.Screen name="forgot-password" options={{ title: 'Forgot password', presentation: 'modal' }} />
            <Stack.Screen name="verify-email" options={{ title: 'Verify email' }} />
            <Stack.Screen name="change-password" options={{ title: 'Change password' }} />
            <Stack.Screen name="messages" options={{ title: 'Messages' }} />
            <Stack.Screen name="conversation/[id]" options={{ title: 'Conversation' }} />
            <Stack.Screen name="blocked" options={{ title: 'Blocked sellers' }} />
            <Stack.Screen name="register" options={{ title: 'Create account', presentation: 'modal' }} />
          </Stack>
        </SavedProvider>
      </LocationProvider>
    </AuthProvider>
  );
}
