"use client";

// Native (iOS) Google + Apple sign-in glue.
//
// The browser-based Auth.js flow can't complete inside the
// Capacitor WebView — the limitsNavigationsToAppBoundDomains
// setting forces OAuth to external Safari and the cookies we set
// inside WKWebView aren't visible there. The fix is to skip the
// OAuth web dance entirely and have the iOS shell talk to the
// provider's native SDK, then POST the resulting signed ID token
// to /api/auth/native-oauth which verifies it and sets
// yuna_session.
//
// Plugin: `@capgo/capacitor-social-login`. Covers both Google
// and Apple in one Capacitor 8-compatible package — the previous
// pair (`@codetrix-studio/capacitor-google-auth` +
// `@capacitor-community/apple-sign-in`) failed Codemagic builds
// because @codetrix-studio ships only a `.podspec` and no
// Package.swift, breaking SPM-based cap sync.

import { Capacitor } from "@capacitor/core";

export type NativeOAuthResult = { ok: true; userId: string } | { ok: false; error: string };

// One-time SocialLogin initialise. The plugin needs the iOS
// OAuth client id at init for Google; Apple is fully native and
// has no init-time config. Initialised lazily so the web build
// never imports the plugin (saves bundle size + avoids running
// iOS-only code in a browser).
let initPromise: Promise<void> | null = null;

async function ensureInitialised(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const iOSClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!iOSClientId) {
      throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");
    }
    const { SocialLogin } = await import("@capgo/capacitor-social-login");
    await SocialLogin.initialize({
      google: { iOSClientId },
      // Apple's iOS-native flow needs no upfront config.
    });
  })();
  return initPromise;
}

async function getGoogleIdToken(): Promise<{ idToken: string } | { error: string }> {
  try {
    await ensureInitialised();
    const { SocialLogin } = await import("@capgo/capacitor-social-login");
    const res = await SocialLogin.login({
      provider: "google",
      options: { scopes: ["profile", "email"] },
    });
    // GoogleLoginResponseOnline shape — has profile + idToken.
    // The offline shape returns a serverAuthCode instead and is
    // a deliberately separate flow we don't use here.
    if (res.result.responseType !== "online") {
      return { error: "Google returned an offline response" };
    }
    const idToken = res.result.idToken;
    if (!idToken) return { error: "Google sign-in returned no idToken" };
    return { idToken };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Google sign-in failed" };
  }
}

async function getAppleIdToken(): Promise<{ idToken: string } | { error: string }> {
  try {
    await ensureInitialised();
    const { SocialLogin } = await import("@capgo/capacitor-social-login");
    const res = await SocialLogin.login({
      provider: "apple",
      options: { scopes: ["name", "email"] },
    });
    const idToken = res.result.idToken;
    if (!idToken) return { error: "Apple sign-in returned no identity token" };
    return { idToken };
  } catch (err) {
    // Capgo surfaces a string error from the iOS layer when the
    // user cancels Sign in with Apple. Friendly message instead
    // of the raw error.
    const message = err instanceof Error ? err.message : String(err);
    if (/cancel/i.test(message)) return { error: "Sign in cancelled" };
    return { error: message || "Apple sign-in failed" };
  }
}

export async function signInNative(provider: "google" | "apple"): Promise<NativeOAuthResult> {
  if (!Capacitor.isNativePlatform()) {
    return { ok: false, error: "Native sign-in is only available inside the app" };
  }
  const tok = provider === "google" ? await getGoogleIdToken() : await getAppleIdToken();
  if ("error" in tok) return { ok: false, error: tok.error };
  const res = await fetch("/api/auth/native-oauth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ provider, idToken: tok.idToken }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; userId?: string; error?: string };
  if (!res.ok || !data?.ok || !data?.userId) {
    return { ok: false, error: data?.error ?? `auth failed (${res.status})` };
  }
  return { ok: true, userId: data.userId };
}
