// Dynamic Expo config. app.json holds the static settings; anything that differs per build
// (API address, store keys) comes from environment variables so no secret or localhost address is baked in by hand.
module.exports = ({ config }) => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || null;
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || null;
  return {
    ...config,
    android: {
      ...config.android,
      ...(mapsKey ? { config: { googleMaps: { apiKey: mapsKey } } } : {}),
    },
    // Read at runtime as a fallback; EXPO_PUBLIC_API_URL (inlined at bundle time) is the primary route.
    extra: { ...config.extra, ...(apiUrl ? { apiUrl } : {}) },
  };
};
