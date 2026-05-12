import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { prisma } from "@/lib/db";
import { setSession } from "@/lib/session";
import { DEFAULT_TRIAL_DAYS } from "@/lib/subscription";

// POST /api/auth/native-oauth
//
// Native iOS Capacitor sign-in flow. The web (browser-based) OAuth
// dance lives behind /api/auth/[...nextauth] and uses Auth.js; that
// path fails inside the Capacitor WebView because
// limitsNavigationsToAppBoundDomains=true forces the OAuth redirect
// to external Safari, and the pkce/state cookies set inside the
// WebView can't be read from Safari.
//
// Native plugins side-step that entirely: the iOS shell talks to
// Google / Apple via their native SDKs (ASWebAuthenticationSession
// for Google, Sign in with Apple for Apple), gets back a signed ID
// token, and POSTs it here. We verify the JWT signature using the
// provider's published JWKS endpoint, find or create the user, and
// set the same `yuna_session` HMAC cookie the rest of the app uses.
// No Auth.js cookies, no cross-domain redirect — the app already
// knows the session is good before this response returns.
//
// Body: { provider: "google" | "apple", idToken: string }
// Returns: { ok: true, userId } on success, { ok: false, error } otherwise.

type Body = { provider?: "google" | "apple"; idToken?: string };

// JWKS endpoints — cached per-process by `createRemoteJWKSet`,
// so repeated logins don't hammer Google/Apple's key servers.
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

type Verified = { sub: string; email: string | null; name: string | null };

async function verifyGoogle(idToken: string): Promise<Verified | { error: string }> {
  const audience = process.env.NATIVE_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
  if (!audience) return { error: "GOOGLE_CLIENT_ID not configured" };
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience,
    });
    return {
      sub: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
    };
  } catch (err) {
    return { error: `google token invalid: ${err instanceof Error ? err.message : "unknown"}` };
  }
}

async function verifyApple(idToken: string): Promise<Verified | { error: string }> {
  // Apple's `aud` claim on the ID token is the iOS app's BUNDLE ID
  // for tokens minted via the Sign in with Apple native flow — NOT
  // the Services ID (APPLE_CLIENT_ID) we use for the web. So accept
  // either one. NATIVE_APPLE_AUDIENCE should be set to the iOS
  // bundle id (com.markforyou.app) on Railway.
  const allowed = [
    process.env.NATIVE_APPLE_AUDIENCE,
    process.env.APPLE_CLIENT_ID,
  ].filter((s): s is string => !!s && s.length > 0);
  if (allowed.length === 0) return { error: "APPLE_CLIENT_ID not configured" };
  try {
    const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: allowed,
    });
    return {
      sub: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : null,
      // Apple only sends `name` on the very first sign-in (and even
      // then in a separate field, not the ID token). Caller can pass
      // it through a follow-up profile update if needed.
      name: null,
    };
  } catch (err) {
    return { error: `apple token invalid: ${err instanceof Error ? err.message : "unknown"}` };
  }
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const { provider, idToken } = body;
  if (!idToken || typeof idToken !== "string") {
    return NextResponse.json({ ok: false, error: "idToken required" }, { status: 400 });
  }
  if (provider !== "google" && provider !== "apple") {
    return NextResponse.json({ ok: false, error: "provider must be 'google' or 'apple'" }, { status: 400 });
  }

  const verified = provider === "google" ? await verifyGoogle(idToken) : await verifyApple(idToken);
  if ("error" in verified) {
    console.warn(`[native-oauth] ${provider} verify failed:`, verified.error);
    return NextResponse.json({ ok: false, error: verified.error }, { status: 401 });
  }

  // Find user: provider-id first, then email fallback for auto-link.
  // Same logic as src/lib/auth.ts so a parent who first signed up
  // with email+password and is now signing in via Google on iOS
  // ends up on the same account.
  const idColumn = provider === "google" ? "googleId" : "appleId";
  let dbUser = await prisma.user.findFirst({ where: { [idColumn]: verified.sub } });
  if (!dbUser && verified.email) {
    const byEmail = await prisma.user.findFirst({
      where: { email: { equals: verified.email, mode: "insensitive" } },
    });
    if (byEmail) {
      dbUser = await prisma.user.update({
        where: { id: byEmail.id },
        data: { [idColumn]: verified.sub, emailVerified: true },
      });
    }
  }
  if (!dbUser) {
    if (!verified.email) {
      // Apple users who chose "Hide my email" still get a relay
      // address in the ID token's email claim — so a missing email
      // really means the token didn't carry one. Bail rather than
      // create an account we can't contact.
      return NextResponse.json({ ok: false, error: "Provider did not return an email" }, { status: 400 });
    }
    const trialEndsAt = new Date(Date.now() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000);
    dbUser = await prisma.user.create({
      data: {
        name: verified.name ?? verified.email.split("@")[0],
        email: verified.email,
        password: crypto.randomUUID(), // never used — OAuth-only account
        role: "PARENT",
        emailVerified: true,
        subscriptionStatus: "trialing",
        trialEndsAt,
        [idColumn]: verified.sub,
      },
    });
  }

  await setSession(dbUser.id);
  return NextResponse.json({ ok: true, userId: dbUser.id });
}
