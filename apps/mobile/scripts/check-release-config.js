// Fails an EAS build early when the release would ship pointing at the wrong backend.
// Wired as the "eas-build-pre-install" script. Run by hand with: node scripts/check-release-config.js
const url = process.env.EXPO_PUBLIC_API_URL || '';
const profile = process.env.EAS_BUILD_PROFILE || '';
const problems = [];
if (profile !== 'development') {
  if (!url) problems.push('EXPO_PUBLIC_API_URL is not set.');
  else {
    let u;
    try { u = new URL(url); } catch { problems.push(`EXPO_PUBLIC_API_URL is not a valid URL: ${url}`); }
    if (u) {
      if (u.protocol !== 'https:') problems.push(`EXPO_PUBLIC_API_URL must be https (got ${u.protocol}).`);
      if (/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(u.hostname)) problems.push(`EXPO_PUBLIC_API_URL points at a local address (${u.hostname}); a phone cannot reach that.`);
      if (/(^|\.)example\.(com|org|net)$/.test(u.hostname)) problems.push('EXPO_PUBLIC_API_URL is still the example placeholder. Put your real API address in eas.json.');
    }
  }
}
// Ads: switching them on in a store build with Google's test ids would show test ads and earn nothing.
const GOOGLE_TEST = '3940256099942544';
if (profile !== 'development' && process.env.EXPO_PUBLIC_ADS_ENABLED === 'true') {
  for (const k of ['ADMOB_ANDROID_APP_ID', 'ADMOB_IOS_APP_ID', 'EXPO_PUBLIC_ADMOB_BANNER_ANDROID', 'EXPO_PUBLIC_ADMOB_BANNER_IOS']) {
    const v = process.env[k] || '';
    if (!v) problems.push(`EXPO_PUBLIC_ADS_ENABLED is true but ${k} is not set.`);
    else if (v.includes(GOOGLE_TEST)) problems.push(`${k} is one of Google's test ids; use your own AdMob id for a store build.`);
  }
}
if (problems.length) {
  console.error('\nRelease configuration problem:\n - ' + problems.join('\n - ') + '\n');
  process.exit(1);
}
console.log(`Release config OK${url ? `: API ${url}` : ' (development profile)'}`);
