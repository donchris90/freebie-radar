// Dynamic Expo config. app.json holds the static settings; anything that differs per build
// (API address, store keys) comes from environment variables so no secret or localhost address is baked in by hand.
module.exports = ({ config }) => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || null;
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || null;
  // Google's published TEST app ids. They are always safe to ship in a debug build and never earn money.
  // The native ads library needs *an* app id in the manifest/Info.plist or the app crashes at launch, so one is always set.
  const GOOGLE_TEST_ANDROID_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
  const GOOGLE_TEST_IOS_APP_ID = 'ca-app-pub-3940256099942544~1458002511';
  const androidAppId = process.env.ADMOB_ANDROID_APP_ID || GOOGLE_TEST_ANDROID_APP_ID;
  const iosAppId = process.env.ADMOB_IOS_APP_ID || GOOGLE_TEST_IOS_APP_ID;

  // If the ads package has not been installed yet (for example `npm install` was not run after pulling this
  // change), Expo cannot even load the config. Skip the plugin with a loud warning instead, so `expo start`
  // still works in Expo Go, where ads are off anyway. Native builds need the package: run `npm install`.
  const plugins = [...(config.plugins || [])];
  let adsInstalled = true;
  try {
    require.resolve('react-native-google-mobile-ads/package.json', { paths: [__dirname] });
  } catch {
    adsInstalled = false;
    console.warn(
      '\n[app.config] react-native-google-mobile-ads is not installed, so the ads plugin is skipped.\n' +
        '             Run `npm install` from the repository root (C:\\freebie-radar) before making a native build.\n',
    );
  }
  if (adsInstalled) plugins.push(['react-native-google-mobile-ads', { androidAppId, iosAppId }]);

  return {
    ...config,
    plugins,
    android: {
      ...config.android,
      ...(mapsKey ? { config: { googleMaps: { apiKey: mapsKey } } } : {}),
    },
    // Read at runtime as a fallback; EXPO_PUBLIC_API_URL (inlined at bundle time) is the primary route.
    extra: { ...config.extra, ...(apiUrl ? { apiUrl } : {}) },
  };
};
