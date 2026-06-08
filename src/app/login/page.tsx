"use client";

// Force this page to render at request time instead of being statically
// pre-rendered at build time. Next.js defaults static pages to
// `Cache-Control: s-maxage=31536000` (1 year) — which means a fresh
// deploy's new HTML (pointing at the new JS chunks) never reaches the
// browser through the CDN. Any client-side bugfix here (the forgot-
// password nested-form was a recent one) sits in a deploy that users
// never see because they get the cached old HTML referencing old chunks.
// Force-dynamic costs us one server render per page load — fine for a
// low-traffic auth page, worth it for safe iterability.
export const dynamic = "force-dynamic";

import { Suspense, useState, useRef, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
// next-auth/react ships a tiny client-side signIn helper that
// handles CSRF + the form POST for OAuth providers. A plain GET
// <a href="/api/auth/signin/google"> isn't a valid Auth.js v5
// entry point — it errors with UnknownAction. signIn() does the
// right thing on the web; iOS uses native plugins instead — see
// the OAuth section below.
import { signIn } from "next-auth/react";
// Capacitor → decide between web (Auth.js) and iOS (native plugins)
// at the click site, so the OAuth buttons render in BOTH places.
import { Capacitor } from "@capacitor/core";
import { signInNative } from "@/lib/native-auth";

// Sanitises a `next=` query string so it can only redirect to a
// path within the same site. Anything that looks like a full URL
// (starts with http://, //, or a non-/ char) is rejected to prevent
// open-redirect attacks. ALSO falls back when the next URL is
// /home/<someone-else>'s-id, to avoid a redirect loop with the
// home layout's "session.userId === params.userId" check.
//
// When justLoggedInUserId is provided AND the next URL is missing a
// userId query param (the iOS account-switch flow uses
// `/login?next=/quiz/<id>`), inject it so quiz/exam pages — which
// still read userId from the URL — work end-to-end. Without this,
// the post-quiz back-navigation lands on `/home/?…` and 404s.
function safeNext(raw: string | null, fallback: string, justLoggedInUserId?: string): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (justLoggedInUserId) {
    const homeMatch = raw.match(/^\/home\/([^/?#]+)/);
    if (homeMatch && homeMatch[1] !== justLoggedInUserId) return fallback;
    // Inject userId into next-paths that pass it as a query param
    // (quiz, exam, test, progress) when it's missing.
    const needsUserId = /^\/(quiz|exam|test|progress|account)\b/.test(raw);
    if (needsUserId && !/[?&]userId=/.test(raw)) {
      const sep = raw.includes("?") ? "&" : "?";
      return `${raw}${sep}userId=${justLoggedInUserId}`;
    }
  }
  return raw;
}

// Next.js 16 requires useSearchParams to be inside a Suspense
// boundary so the page can prerender. Wrap the actual login UI in a
// child component and render it inside Suspense from the route's
// default export.
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextParam = searchParams.get("next");

  // ── Login state ──
  const [loginIdentity, setLoginIdentity] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginShowPw, setLoginShowPw] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  // NextAuth redirects here with `?error=<code>` when an OAuth round-
  // trip fails — usually a deploy-time race where the PKCE / state
  // cookies were set on an old build and validated against a new
  // one. Surface a human-readable message and clear the param off
  // the URL so a refresh doesn't keep re-showing it.
  useEffect(() => {
    const oauthErrorParam = searchParams.get("error");
    if (!oauthErrorParam) return;
    const msg = oauthErrorParam === "OAuthCallback" || oauthErrorParam === "InvalidCheck" || oauthErrorParam === "OAuthSignin"
      ? "Sign-in was interrupted (possibly by a deploy). Please try again."
      : oauthErrorParam === "AccessDenied"
        ? "You cancelled the sign-in. Try again or use email + password."
        : oauthErrorParam === "Configuration"
          ? "Sign-in is temporarily unavailable. Please try again in a minute."
          : `Sign-in failed (${oauthErrorParam}). Please try again.`;
    setLoginError(msg);
    // Strip the error from the URL so reloading the page doesn't
    // re-show the same banner.
    const qs = new URLSearchParams(window.location.search);
    qs.delete("error");
    const newSearch = qs.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${newSearch ? `?${newSearch}` : ""}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Ref to the password input so we can auto-focus it after the
  // username has been pre-filled from the next= redirect lookup.
  const passwordInputRef = useRef<HTMLInputElement>(null);

  // Pre-fill priority (highest first):
  //   1. ?identity=…  — set by /reset-password after a successful
  //      reset, so the just-reset account's email/username is shown
  //      regardless of any leftover state.
  //   2. ?next=/home/<userId>  — set by the home-layout redirect when
  //      a logged-out user clicks a shared link. Looks up the name.
  // On any failure (network, 404, unparseable), leave the field empty.
  // Auto-focus the password input once filled so the cursor lands
  // ready to type.
  const identityParam = searchParams.get("identity");
  useEffect(() => {
    if (identityParam) {
      setLoginIdentity(identityParam);
      setTimeout(() => passwordInputRef.current?.focus(), 0);
      return;
    }
    if (!nextParam) return;
    const match = nextParam.match(/^\/home\/([^/?#]+)/);
    if (!match) return;
    const userId = match[1];
    let cancelled = false;
    fetch(`/api/users/lookup?id=${encodeURIComponent(userId)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { name: string | null } | null) => {
        if (cancelled || !data?.name) return;
        setLoginIdentity(data.name);
        setTimeout(() => passwordInputRef.current?.focus(), 0);
      })
      .catch(() => { /* leave identity empty on any error */ });
    return () => { cancelled = true; };
  }, [nextParam, identityParam]);

  // OAuth provider mode:
  //   - Web: Auth.js OAuth dance via signIn() (cookies, pkce, etc.)
  //   - iOS: native sign-in plugins → ID token → POST
  //     /api/auth/native-oauth → yuna_session cookie set server-side
  // We default `isNativeOauth` false to avoid a hydration mismatch
  // (Capacitor.isNativePlatform() returns false during SSR) and
  // flip it after mount. Buttons render in both modes.
  const [isNativeOauth, setIsNativeOauth] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthLoading, setOauthLoading] = useState<"google" | "apple" | null>(null);
  // iOS Safari/Chrome Private Mode discards the pkceCodeVerifier
  // cookie across the Google OAuth round-trip, breaking sign-in
  // with InvalidCheck. Detect best-effort (UA + storage probe) and
  // warn before the user wastes a click. Detection runs only after
  // mount to avoid SSR hydration mismatch.
  const [iosPrivateMode, setIosPrivateMode] = useState(false);
  useEffect(() => {
    setIsNativeOauth(Capacitor.isNativePlatform());

    // iOS WebKit detection: matches both iOS Safari and iOS Chrome
    // (Chrome on iOS is forced to WebKit by Apple, so it inherits
    // the same private-mode behaviour).
    const ua = navigator.userAgent;
    const isIOSWebKit = /iPad|iPhone|iPod/.test(ua) && !/CriOS\/.*Edg/.test(ua);
    if (!isIOSWebKit) return;
    // Storage quota probe — private mode reports a tiny quota
    // (~100MB on modern iOS) vs. GBs in normal browsing. Wrapped in
    // try/catch because navigator.storage isn't on every iOS version.
    (async () => {
      try {
        const est = await navigator.storage?.estimate?.();
        if (est?.quota && est.quota < 200_000_000) setIosPrivateMode(true);
      } catch { /* probe failed — leave banner off */ }
    })();
  }, []);

  async function handleOauthClick(provider: "google" | "apple") {
    setOauthError(null);
    if (!isNativeOauth) {
      // Browser path: hand off to Auth.js.
      void signIn(provider, { redirectTo: "/post-login" });
      return;
    }
    setOauthLoading(provider);
    try {
      const result = await signInNative(provider);
      if (!result.ok) {
        setOauthError(result.error);
        return;
      }
      router.push(`/home/${result.userId}`);
    } finally {
      setOauthLoading(null);
    }
  }

  // ── Forgot password state ──
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotDone, setForgotDone] = useState(false);
  const [forgotError, setForgotError] = useState("");

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotError("");
    if (!forgotEmail.trim()) { setForgotError("Please enter your email."); return; }
    setForgotLoading(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });
      setForgotDone(true);
    } catch {
      setForgotError("Something went wrong. Please try again.");
    } finally {
      setForgotLoading(false);
    }
  }

  // ── Sign-up state ──
  const [tab, setTab] = useState<"student" | "parent">("parent");
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupLevel, setSignupLevel] = useState(4);
  const [signupError, setSignupError] = useState("");
  const [signupLoading, setSignupLoading] = useState(false);

  // Username availability check
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [checkingName, setCheckingName] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkName = useCallback((n: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!n.trim()) { setNameAvailable(null); return; }
    setCheckingName(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/check?name=${encodeURIComponent(n.trim())}`);
        const data = await res.json();
        setNameAvailable(data.available);
      } catch { setNameAvailable(null); }
      finally { setCheckingName(false); }
    }, 400);
  }, []);

  // ── Handlers ──
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    if (!loginIdentity.trim() || !loginPassword) {
      setLoginError("Please enter your name/email and password.");
      return;
    }
    setLoginLoading(true);
    try {
      const isEmail = loginIdentity.includes("@");
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEmail
            ? { email: loginIdentity.trim(), password: loginPassword }
            : { name: loginIdentity.trim(), password: loginPassword }
        ),
      });
      if (!res.ok) {
        const data = await res.json();
        setLoginError(data.error || "Login failed");
        // Clear the password so the next attempt isn't autofilled
        // back to the same wrong value. iOS WebView in particular
        // would re-fill it from the input cache on retry, making
        // it look like multiple attempts were "all failing" when
        // really the same password was being resent.
        setLoginPassword("");
        return;
      }
      const user = await res.json();
      // After a password login, go straight to /home/<userId>. The
      // previous behaviour (router.push(safeNext(nextParam, …)))
      // honoured the `next=` param the gating layout sets when
      // bouncing a logged-out user to /login. Re-opening the browser
      // to a stale deep link (/exam/<id>/review?userId=…&long-chain)
      // then routed the user back there after login — and the page
      // stalled because session hydration raced the data fetch, or
      // the URL pointed at moved / cleared state. Home is a fast,
      // predictable landing page; one tap from there gets to the
      // intended paper.
      // EXCEPTION — iOS native app only. The Capacitor account-
      // switch flow uses `/login?next=/quiz/<id>` to land the parent
      // back on the right quiz after they've impersonated a child;
      // breaking that would break the iOS quiz flow. Web browsers
      // ALWAYS go home; only the native shell honours next=.
      const isNativeApp = Capacitor.isNativePlatform();
      const dest = isNativeApp
        ? safeNext(nextParam, `/home/${user.id}`, user.id)
        : `/home/${user.id}`;
      router.push(dest);
    } catch {
      setLoginError("Something went wrong. Please try again.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleSignup() {
    setSignupError("");
    if (!signupName.trim()) { setSignupError("Username is required."); return; }
    if (!signupPassword) { setSignupError("Password is required."); return; }
    if (tab === "parent" && !signupEmail.trim()) { setSignupError("Email is required for parent accounts."); return; }
    if (nameAvailable === false) { setSignupError("Username is already taken."); return; }

    setSignupLoading(true);
    try {
      const body =
        tab === "student"
          ? { name: signupName.trim(), role: "STUDENT", password: signupPassword, level: signupLevel }
          : { name: signupName.trim(), role: "PARENT", email: signupEmail.trim(), password: signupPassword };

      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        setSignupError(data.error || "Registration failed");
        return;
      }
      const user = await res.json();
      if (tab === "parent") {
        router.push(`/register/student?parentId=${user.id}`);
      } else {
        router.push(`/home/${user.id}`);
      }
    } catch {
      setSignupError("Something went wrong. Please try again.");
    } finally {
      setSignupLoading(false);
    }
  }

  return (
    <div className="bg-surface font-body text-on-surface min-h-screen flex flex-col lg:flex-row items-center justify-center p-6 lg:p-12 relative overflow-hidden gap-8 lg:gap-16">

      {/* Decorative blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-surface-container-high rounded-full blur-[120px] opacity-60 pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-secondary-container rounded-full blur-[120px] opacity-30 pointer-events-none" />

      <main className="w-full max-w-[480px] z-10 lg:shrink-0">

        {/* Header */}
        <div className="flex flex-col items-center mb-10">
          <Link href="/" className="w-20 h-20 mb-6 bg-surface-container-lowest rounded-xl flex items-center justify-center" style={{ boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="MarkForYou Owl Logo" className="w-14 h-14 object-contain" src="/logo_t.png" />
          </Link>
          <h1 className="font-headline font-extrabold text-3xl tracking-tight text-primary mb-2">MarkForYou.com</h1>
        </div>

        {/* Card */}
        <div className="bg-surface-container-lowest rounded-[2rem] p-8 md:p-12 border border-white/40" style={{ boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}>

          {/* ── Login Form ── */}
          <form onSubmit={handleLogin} className="space-y-6">
            {/* Identity */}
            <div className="space-y-2">
              <label className="block font-headline font-bold text-sm text-primary ml-1" htmlFor="identity">
                Name or Email Address
              </label>
              <div className="relative group">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline-variant group-focus-within:text-primary transition-colors">person</span>
                <input
                  id="identity"
                  type="text"
                  value={loginIdentity}
                  onChange={e => setLoginIdentity(e.target.value)}
                  placeholder="Enter your name or email"
                  className="w-full pl-12 pr-4 py-4 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary-container text-on-surface placeholder:text-outline transition-all outline-none"
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-2">
              <div className="flex justify-between items-center px-1">
                <label className="block font-headline font-bold text-sm text-primary" htmlFor="login-password">Password</label>
                <button type="button" onClick={() => { setForgotOpen(true); setForgotDone(false); setForgotEmail(""); setForgotError(""); }} className="text-xs font-semibold text-on-surface-variant hover:text-primary transition-colors">Forgot Password?</button>
              </div>
              <div className="relative group">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline-variant group-focus-within:text-primary transition-colors">lock</span>
                <input
                  ref={passwordInputRef}
                  id="login-password"
                  type={loginShowPw ? "text" : "password"}
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-12 pr-12 py-4 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary-container text-on-surface placeholder:text-outline transition-all outline-none"
                />
                <button
                  type="button"
                  onClick={() => setLoginShowPw(v => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-outline-variant hover:text-primary"
                >
                  <span className="material-symbols-outlined">{loginShowPw ? "visibility_off" : "visibility"}</span>
                </button>
              </div>
            </div>

            {loginError && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-error font-medium">{loginError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setLoginIdentity("");
                    setLoginPassword("");
                    setLoginError("");
                  }}
                  className="text-xs font-bold text-primary hover:underline whitespace-nowrap"
                >
                  Clear &amp; retry
                </button>
              </div>
            )}

            {/* Forgot password inline panel */}
            {forgotOpen && (
              <div className="bg-surface-container-low rounded-2xl p-5 space-y-3">
                {forgotDone ? (
                  <div className="flex flex-col items-center text-center gap-3 py-2">
                    <div className="w-12 h-12 rounded-full bg-secondary-container flex items-center justify-center">
                      <span className="material-symbols-outlined text-on-secondary-container text-3xl">mark_email_read</span>
                    </div>
                    <p className="text-base text-on-surface font-headline font-bold">Check your email</p>
                    <p className="text-sm text-on-surface-variant">
                      If <span className="font-semibold">{forgotEmail}</span> is registered, we&apos;ve sent you a link to reset your password. The link is valid for 1 hour.
                    </p>
                    <p className="text-xs text-on-surface-variant bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-1">
                      💡 <span className="font-semibold">Tip:</span> the reset email might land in your <span className="font-semibold">spam</span> or <span className="font-semibold">promotions</span> folder.
                    </p>
                  </div>
                ) : (
                  // NOT a <form> — this panel renders INSIDE the parent
                  // <form onSubmit={handleLogin}> above. Nested forms are
                  // invalid HTML; the browser strips the inner one, which
                  // means a <button type="submit"> inside would submit the
                  // outer login form instead of running handleForgot.
                  // Wired as a button with explicit onClick instead, and
                  // Enter-in-the-email-field calls handleForgot directly.
                  <div className="space-y-3">
                    <p className="text-xs text-on-surface-variant font-medium">Enter your registered email and we&apos;ll send you a reset link.</p>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline-variant text-sm">mail</span>
                      <input
                        type="email"
                        value={forgotEmail}
                        onChange={e => setForgotEmail(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleForgot(e as unknown as React.FormEvent);
                          }
                        }}
                        placeholder="your@email.com"
                        className="w-full pl-11 pr-4 py-3 bg-white border-none rounded-xl focus:ring-2 focus:ring-primary-container text-on-surface text-sm outline-none"
                      />
                    </div>
                    {forgotError && <p className="text-xs text-error">{forgotError}</p>}
                    <button
                      type="button"
                      onClick={(e) => handleForgot(e as unknown as React.FormEvent)}
                      disabled={forgotLoading}
                      className="w-full py-3 bg-primary text-on-primary font-bold text-sm rounded-xl hover:scale-[1.02] transition-transform disabled:opacity-60"
                    >
                      {forgotLoading ? "Sending…" : "Send reset link"}
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full py-4 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-lg rounded-xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2 mt-2 disabled:opacity-60"
              style={{ boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}
            >
              {loginLoading ? "Logging in…" : "Login"}
              {!loginLoading && <span className="material-symbols-outlined">arrow_forward</span>}
            </button>
          </form>

          {/* ── OAuth providers ──
              Web: Auth.js redirect dance. iOS: native plugin → ID
              token → /api/auth/native-oauth. Same buttons either
              way; handleOauthClick picks the right path. */}
          <div className="mt-8">
            <div className="relative flex items-center mb-5">
              <div className="flex-grow border-t border-surface-container" />
              <span className="px-3 text-xs font-medium text-outline-variant">or continue with</span>
              <div className="flex-grow border-t border-surface-container" />
            </div>
            {iosPrivateMode && (
              <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <span className="font-bold">Private browsing detected.</span> Google sign-in on iPhone needs a normal Safari tab — private mode discards the security cookie between you and Google. Use a regular tab for the first sign-in (session lasts 30 days), or download the iOS app.
              </div>
            )}
            {/* Apple web sign-in disabled — the SameSite=None
                workaround it required was breaking Google sign-in
                in privacy-strict browsers (Chrome incognito,
                Brave, Safari ITP) with InvalidCheck:
                pkceCodeVerifier. iOS app users still get Apple
                via the native plugin → /api/auth/native-oauth. */}
            <div className="grid grid-cols-1 gap-3">
              <button
                type="button"
                onClick={() => handleOauthClick("google")}
                disabled={!!oauthLoading}
                className="flex items-center justify-center gap-2 py-3 rounded-xl bg-white border border-surface-container hover:bg-surface-container-low transition-colors font-headline font-bold text-sm text-on-surface disabled:opacity-60"
              >
                {/* Inline Google G — avoids fetching an extra asset */}
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                {oauthLoading === "google" ? "Signing in…" : "Continue with Google"}
              </button>
            </div>
            {oauthError && (
              <p className="text-xs text-error mt-3 text-center">{oauthError}</p>
            )}
          </div>

          {/* ── Try-for-free CTA ── */}
          <div className="mt-10 pt-8 border-t border-surface-container">
            <Link
              href="/signup"
              className="w-full flex items-center justify-center gap-2 py-4 bg-secondary text-on-secondary font-headline font-bold text-lg rounded-xl hover:scale-[1.02] active:scale-[0.98] transition-all"
              style={{ boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}
            >
              Try for FREE
              <span className="material-symbols-outlined">arrow_forward</span>
            </Link>
          </div>
        </div>

      </main>

      {/* Right side: hero image — matches step 1 of the signup flow. The
          aside has a fixed width AND the inner frame is aspect-square so
          layout doesn't shift when step1.png finishes loading — the login
          form is already in its final left position on first paint. */}
      <aside className="hidden lg:flex z-10 w-[520px] shrink-0 flex-col items-center">
        <div
          className="w-full aspect-square rounded-[2rem] overflow-hidden border-4 border-white/70 bg-surface-container-low"
          style={{ boxShadow: "0 30px 60px rgba(11,28,48,0.15)" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/step1.png"
            alt="Mother and child learning together"
            width={512}
            height={512}
            className="w-full h-full object-cover block"
          />
        </div>
      </aside>

    </div>
  );
}
