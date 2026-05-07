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
  },
};

export default config;
