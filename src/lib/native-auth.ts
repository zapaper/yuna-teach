"use client";

// Native (iOS) Google + Apple sign-in glue.
//
// The browser-based Auth.js flow can't complete inside the
// Capacitor WebView — see src/lib/auth.ts and the cookie-jar split
// problem documented in commit 67cf848. The fix on iOS is to skip
// the OAuth web dance entirely and use each provider's native
// SDK to obtain a signed ID token, then POST that token to
// `/api/auth/native-oauth` which verifies it and sets our
// yuna_session cookie.
//
// Plugin choices:
//   - Apple: `@capacitor-community/apple-sign-in` (uses
//     iOS's native AuthenticationServices, including "Sign in
//     with Apple" — an App Store requirement once Google sign-in
//     is offered alongside).
//   - Google: `@codetrix-studio/capacitor-google-auth` (wraps
//     Google's iOS SDK).
//
// Plugins are dynamic-imported so the web bundle doesn't pull
// them in for browser users (the modules contain iOS-specific
// surface that won't run server-side).

import { Capacitor } from "@capacitor/core";

export type NativeOAuthResult = { ok: true; userId: string } | { ok: false; error: string };

let googleInitialised = false;

async function ensureGoogleConfigured(): Promise<void> {
  if (googleInitialised) return;
  // NEXT_PUBLIC_GOOGLE_CLIENT_ID — the iOS OAuth 2.0 client id
  // from the Google Cloud console. Different from the WEB client
  // id used by Auth.js on the server.
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");
  }
  const { GoogleAuth } = await import("@codetrix-studio/capacitor-google-auth");
  await GoogleAuth.initialize({
    clientId,
    scopes: ["profile", "email"],
    grantOfflineAccess: false,
  });
  googleInitialised = true;
}

async function getGoogleIdToken(): Promise<{ idToken: string } | { error: string }> {
  try {
    await ensureGoogleConfigured();
    const { GoogleAuth } = await import("@codetrix-studio/capacitor-google-auth");
    const user = await GoogleAuth.signIn();
    const idToken = user?.authentication?.idToken;
    if (!idToken) return { error: "Google sign-in returned no idToken" };
    return { idToken };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Google sign-in failed" };
  }
}

async function getAppleIdToken(): Promise<{ idToken: string } | { error: string }> {
  try {
    const { SignInWithApple } = await import("@capacitor-community/apple-sign-in");
    // clientId / redirectURI are only used on the web fallback —
    // on iOS Sign in with Apple runs natively and ignores them.
    // We still pass the bundle id for consistency in case the
    // plugin uses it for token audience validation.
    const result = await SignInWithApple.authorize({
      clientId: process.env.NEXT_PUBLIC_APPLE_BUNDLE_ID ?? "com.markforyou.app",
      redirectURI: "",
      scopes: "email name",
      state: "",
      nonce: "",
    });
    const idToken = result?.response?.identityToken;
    if (!idToken) return { error: "Apple sign-in returned no identity token" };
    return { idToken };
  } catch (err) {
    // The plugin throws { code: "1001" } when the user cancels —
    // surface a friendly message rather than the raw code.
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "1001") return { error: "Sign in cancelled" };
    return { error: err instanceof Error ? err.message : "Apple sign-in failed" };
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
