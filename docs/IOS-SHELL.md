# iOS Shell — Mac-Side Setup

The Capacitor scaffold (npm packages, `capacitor.config.ts`,
placeholder `capacitor-out/`, native helpers in `src/lib/native.ts`)
is committed and works cross-platform. The remaining steps **must
run on macOS** because they invoke Xcode + CocoaPods.

## Prereqs on the Mac

```bash
# Apple-side
xcode-select --install         # command-line tools
sudo gem install cocoapods     # if not already

# Project-side (clone the repo first)
git clone https://github.com/zapaper/yuna-teach
cd yuna-teach
nvm use 20                     # or whatever you use
npm install
```

## One-time iOS scaffold

```bash
# Adds the ios/ directory with the Xcode project.
npx cap add ios
# Pulls our Capacitor plugins (camera, push, preferences, RevenueCat)
# into the Xcode project's Pods.
npx cap sync ios
# Open in Xcode.
npx cap open ios
```

In Xcode:
- Top-left, click `App` → `Signing & Capabilities`.
- Team: pick your Apple Developer team.
- Bundle Identifier: `com.markforyou.app` (matches App Store Connect).
- Add capabilities (`+ Capability` button):
  - **In-App Purchase** — required for IAP.
  - **Push Notifications** — required if we ship the daily-quiz reminder later.
  - **Sign in with Apple** — required if we add 3rd-party login later.
- Privacy strings (`App` → `Info`):
  - `NSCameraUsageDescription` → "MarkForYou uses the camera so you can scan your child's exam paper for marking."
  - `NSPhotoLibraryUsageDescription` → "Pick an existing photo of the exam paper instead of taking a new one."

## App-bound domains (lock the WebView to markforyou.com)

In `ios/App/App/Info.plist`, add:

```xml
<key>WKAppBoundDomains</key>
<array>
  <string>markforyou.com</string>
  <string>www.markforyou.com</string>
</array>
```

Capacitor's `limitsNavigationsToAppBoundDomains: true` (already in
`capacitor.config.ts`) requires this list. Without it the WebView
falls back to unrestricted navigation.

## Running in Simulator

```bash
# from project root
npx cap run ios
```

Pick an iPad simulator. Should boot, show the splash, then load
www.markforyou.com.

## Sandbox StoreKit testing

1. App Store Connect → Users and Access → Sandbox Testers → +.
2. Create a tester (use a fresh email — can't reuse your real Apple ID).
3. On the Mac/Simulator: Settings → Developer → Sandbox Apple Account → sign in as the tester.
4. Run the app, hit "Subscribe", confirm the StoreKit sheet shows
   sandbox pricing.

Sandbox subscriptions auto-renew on accelerated time:
- 1 month → 5 minutes
- 1 year → 1 hour
Useful for testing renewal + ASN-webhook delivery in minutes
instead of waiting weeks.

## When you change web code

You don't need to do anything iOS-side for normal web/backend
deploys. The WebView reloads www.markforyou.com on every app launch.

## When you change native plugins / Capacitor config

```bash
npx cap sync ios
# then in Xcode, Product → Clean Build Folder, then build again.
```

## Building for TestFlight

In Xcode:
- Top bar device selector → "Any iOS Device (arm64)".
- Product → Archive.
- Once archived: Distribute App → App Store Connect → Upload.
- Wait ~10 min for App Store Connect to finish processing.
- TestFlight tab in App Store Connect → add internal/external testers.

## Env vars needed on iOS build

The iOS app needs the **public RevenueCat iOS SDK key**
(`appl_...`, NOT the `test_...` web key) at build time. We expose it
via `NEXT_PUBLIC_REVENUECAT_IOS_KEY` so it gets baked into the
Next.js bundle that the WebView loads.

Set it in Railway's Variables tab:

```
NEXT_PUBLIC_REVENUECAT_IOS_KEY = appl_YourKeyFromRevenueCatDashboard
```

Important: this is exposed to the client (any user with devtools
can read it). RevenueCat's public SDK keys are designed for that —
they only allow read-only client interactions; the secret is your
`REVENUECAT_SECRET_KEY` which stays server-side.
