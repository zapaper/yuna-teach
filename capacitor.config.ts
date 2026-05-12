import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor config for the iOS shell. The shell is a thin native
// wrapper that loads www.markforyou.com in a WKWebView. Web code
// continues to deploy via Vercel/Railway as today; we only need to
// rebuild + resubmit the iOS shell when native plugins or app
// metadata change.
//
// server.url makes the WebView point at production directly, which
// is exactly what we want for OTA-style web updates. Apple is fine
// with this as long as the App Store listing's purpose stays
// consistent with what the website does (Guideline 4.7).

const config: CapacitorConfig = {
  appId: "com.markforyou.app",
  appName: "MarkForYou",
  // Required by the CLI even when server.url is set; the WebView
  // briefly loads from this directory before redirecting to
  // server.url. Keep a tiny placeholder index.html so the cold-start
  // splash isn't a white flash.
  webDir: "capacitor-out",
  server: {
    url: "https://www.markforyou.com",
    cleartext: false,
  },
  ios: {
    contentInset: "automatic",
    // WKAppBoundDomains is set in Info.plist (the manifest the iOS
    // shell ships) — keeps the WebView locked to markforyou.com so
    // a stray external link can't escape.
    limitsNavigationsToAppBoundDomains: true,
    // Required for WKAppBoundDomains to actually take effect.
    // Capacitor injects this via the same Info.plist when the iOS
    // project is regenerated with `npx cap sync ios`.
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    // Native Google sign-in (iOS). clientId is the iOS OAuth 2.0
    // client id from the Google Cloud console — distinct from the
    // GOOGLE_CLIENT_ID env var used by Auth.js for the web flow.
    // Server-side ID-token verification accepts EITHER audience
    // (see /api/auth/native-oauth/route.ts), so the same Google
    // project covers both web and iOS.
    //
    // The plugin reads this at native-init time. The runtime
    // initialize() call in src/lib/native-auth.ts also accepts a
    // clientId — it must match this one. Configure here so the
    // initialize() call after `npx cap sync ios` picks up the
    // correct iOS client id even if NEXT_PUBLIC_GOOGLE_CLIENT_ID
    // is missing in a build environment.
    GoogleAuth: {
      scopes: ["profile", "email"],
      serverClientId: process.env.GOOGLE_CLIENT_ID,
      forceCodeForRefreshToken: false,
    },
  },
};

export default config;
