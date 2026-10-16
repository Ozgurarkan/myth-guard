# Myth Guard Player for Android

The Android project lives in `android/`. It is a Capacitor shell for the existing
player experience: it opens the GM's `player.html` page inside the app, so all
table data stays on the same home Wi-Fi network.

## Run it on a phone

1. Install Android Studio and its Android SDK on a Windows computer.
2. Run `npm install` in the project root.
3. Run `npm run android:sync` after changing `mobile/player/` or Capacitor settings.
4. Run `npm run android:open`, then use Android Studio's **Run** button with a
   phone or emulator selected.
5. In the app, paste the **Copy invite link** URL from the GM's Invite Players
   dialog. The player app remembers the last table address.

The app deliberately allows local `http://` connections. Myth Guard tables run
on the GM's private Wi-Fi; HTTPS is not required or expected for that use case.

## Release build

In Android Studio: **Build > Generate Signed Bundle / APK > Android App Bundle**.
Use an AAB for Google Play and a signed APK for direct installation.

The Android package id is `com.mythguard.player`. Create and retain a release
keystore before distributing any build; changing it prevents existing users from
installing updates.

## Deep links

The app registers `mythguard://join?url=<encoded invite URL>`. This is ready for
a future Android-specific QR action. Standard browser QR links continue to work
for players who prefer a browser.
