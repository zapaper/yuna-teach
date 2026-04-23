"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();

  // ── Login state ──
  const [loginIdentity, setLoginIdentity] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginShowPw, setLoginShowPw] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

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
        return;
      }
      const user = await res.json();
      router.push(`/home/${user.id}`);
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
                <button type="button" onClick={() => { setForgotOpen(true); setForgotDone(false); setForgotEmail(""); setForgotError(""); }} className="text-xs font-semibold text-outline-variant hover:text-primary transition-colors">Forgot Password?</button>
              </div>
              <div className="relative group">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline-variant group-focus-within:text-primary transition-colors">lock</span>
                <input
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
              <p className="text-sm text-error font-medium">{loginError}</p>
            )}

            {/* Forgot password inline panel */}
            {forgotOpen && (
              <div className="bg-surface-container-low rounded-2xl p-5 space-y-3">
                {forgotDone ? (
                  <p className="text-sm text-secondary font-medium text-center">
                    If that email is registered, we&apos;ve sent the password to it.
                  </p>
                ) : (
                  <form onSubmit={handleForgot} className="space-y-3">
                    <p className="text-xs text-on-surface-variant font-medium">Enter your registered email and we&apos;ll send your password.</p>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline-variant text-sm">mail</span>
                      <input
                        type="email"
                        value={forgotEmail}
                        onChange={e => setForgotEmail(e.target.value)}
                        placeholder="your@email.com"
                        className="w-full pl-11 pr-4 py-3 bg-white border-none rounded-xl focus:ring-2 focus:ring-primary-container text-on-surface text-sm outline-none"
                      />
                    </div>
                    {forgotError && <p className="text-xs text-error">{forgotError}</p>}
                    <button
                      type="submit"
                      disabled={forgotLoading}
                      className="w-full py-3 bg-primary text-on-primary font-bold text-sm rounded-xl hover:scale-[1.02] transition-transform disabled:opacity-60"
                    >
                      {forgotLoading ? "Sending…" : "Send Password"}
                    </button>
                  </form>
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

      {/* Right side: hero image — matches step 1 of the signup flow so the
          login page visually ties into the onboarding journey. Hidden on
          mobile so the form gets the full viewport. */}
      <aside className="hidden lg:flex z-10 max-w-[520px] flex-col items-center">
        <div className="w-full rounded-[2rem] overflow-hidden border-4 border-white/70" style={{ boxShadow: "0 30px 60px rgba(11,28,48,0.15)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/step1.png"
            alt="Mother and child learning together"
            className="w-full h-auto object-cover block"
          />
        </div>
      </aside>

    </div>
  );
}
