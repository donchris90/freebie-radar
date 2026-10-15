# Ads (Google AdMob)

Free accounts see a labelled banner on **Discover** and at the bottom of **Search results**. Premium accounts see none. There is no ad anywhere else, and the code has no way to place one on sign-in, alerts, messages, payment, listing detail or posting screens (`Placement` in `apps/mobile/src/ads.tsx` is `'home' | 'search'`).

## Behaviour

- **Off by default.** Ads appear only in a build made with `EXPO_PUBLIC_ADS_ENABLED=true`.
- **Consent first.** Where the law requires it (UK/EEA, some US states) Google's consent form (UMP) is shown before any ad is requested. If the person declines, no ad loads. When Google says privacy options are required, Profile shows "Ad privacy choices".
- **Content rating** is limited to PG, and the app is not child-directed.
- **No ads for Premium**, decided from the signed-in tier. An ad that fails to load removes its whole slot, so there is never an empty gap.
- **Expo Go cannot show ads** (the native module is not in it); the app simply shows none there. Use a development build: `eas build --profile development`.

## Going live

1. Create an AdMob account and add the Android and iOS apps (bundle id `com.freebieradar.app`). AdMob gives you an **app id** and a **banner ad unit id** for each platform.
2. Set these in the EAS build environment (never commit them):
   ```
   EXPO_PUBLIC_ADS_ENABLED=true
   ADMOB_ANDROID_APP_ID=ca-app-pub-XXXX~YYYY
   ADMOB_IOS_APP_ID=ca-app-pub-XXXX~ZZZZ
   EXPO_PUBLIC_ADMOB_BANNER_ANDROID=ca-app-pub-XXXX/AAAA
   EXPO_PUBLIC_ADMOB_BANNER_IOS=ca-app-pub-XXXX/BBBB
   ```
3. `node apps/mobile/scripts/check-release-config.js` (it runs automatically before an EAS build) **fails** a store build that turns ads on with missing ids or Google's test ids.
4. In AdMob, set up your **GDPR / US state privacy message** (Privacy & messaging). Without a published message the consent form cannot appear and, in the UK/EEA, no ads will serve.
5. Update your store listings: Google Play **Data safety** (advertising ID, device identifiers) and Apple **App Privacy** details; add ads to your **privacy policy**.

## What is not done / not verified

- **Never run on a device.** The config plugin was checked with a real Android prebuild (the AdMob app id lands in the manifest) and the JS bundle exports for Android. Nobody has seen an ad render, nor the consent form, on a phone.
- **iOS App Tracking Transparency is not requested.** Without it iOS serves non-personalised ads. Add `expo-tracking-transparency` and a usage description if you want personalised ads on iPhone.
- **Revenue.** Test ads earn nothing; real ads need an approved AdMob account and a published privacy message.
- The Premium screen says "No ads anywhere in the app". Keep that true if you add placements.
