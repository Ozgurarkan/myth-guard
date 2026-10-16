# Myth Guard Player for iOS and macOS

The native Apple project lives in `ios/App/`. It uses the same player shell as
Android and opens the GM's local `player.html` page inside the native app.

## Requirements

Building Apple apps requires a Mac with Xcode. This Windows computer can keep
the shared web assets and Xcode project synchronized, but cannot produce an IPA
or macOS app archive.

## iPhone and iPad

1. Move or clone this project on a Mac, then run `npm install`.
2. Run `npm run ios:sync`.
3. Run `npm run ios:open` or open `ios/App/App.xcworkspace` in Xcode.
4. Choose a development team and a connected iPhone/iPad or simulator, then run.
5. In the app, paste the invite link copied from the GM's Invite Players dialog.

The app includes the local-network privacy explanation shown by iOS and permits
HTTP only because the Game Master hosts a private LAN table directly.

## macOS

The Xcode target has Mac Catalyst enabled. In Xcode, select the **App** target,
choose **My Mac (Mac Catalyst)** as the run destination, and run or archive it.
Use **Product > Archive** to create a distributable macOS build.

Before App Store distribution, set a real Apple Developer team, increment the
build number, create an app record in App Store Connect, and provide the local
network permission rationale during review.
