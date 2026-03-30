"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { User } from "@/types";

type Mode = "idle" | "register-student" | "register-parent";

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");

  // Login state
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  // Register state
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPw, setRegPw] = useState("");
  const [regPwConfirm, setRegPwConfirm] = useState("");
  const [regLevel, setRegLevel] = useState(4);
  const [regError, setRegError] = useState("");
  const [registering, setRegistering] = useState(false);

  // Username availability (student)
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [checkingName, setCheckingName] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkName = useCallback((name: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!name.trim()) { setNameAvailable(null); return; }
    setCheckingName(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/check?name=${encodeURIComponent(name.trim())}`);
        const data = await res.json();
        setNameAvailable(data.available);
      } catch { setNameAvailable(null); }
      finally { setCheckingName(false); }
    }, 400);
  }, []);

  async function handleLogin() {
    setLoginError("");
    setLoggingIn(true);
    try {
      // Determine if input looks like email
      const isEmail = loginId.includes("@");
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEmail
            ? { email: loginId.trim(), password: loginPw }
            : { name: loginId.trim(), password: loginPw }
        ),
      });
      if (!res.ok) {
        const data = await res.json();
        setLoginError(data.error || "Login failed");
        return;
      }
      const user: User = await res.json();
      router.push(`/home/${user.id}`);
    } catch {
      setLoginError("Something went wrong");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleRegister() {
    setRegError("");

    if (!regName.trim()) { setRegError("Name is required"); return; }
    if (!regPw) { setRegError("Password is required"); return; }
    if (regPw !== regPwConfirm) { setRegError("Passwords don't match"); return; }
    if (mode === "register-parent" && !regEmail.trim()) { setRegError("Email is required"); return; }
    if (mode === "register-student" && nameAvailable === false) { setRegError("Username is taken"); return; }

    setRegistering(true);
    try {
      const role = mode === "register-student" ? "STUDENT" : "PARENT";
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: regName.trim(),
          role,
          password: regPw,
          email: role === "PARENT" ? regEmail.trim() : null,
          level: role === "STUDENT" ? regLevel : null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setRegError(data.error || "Registration failed");
        return;
      }
      const user: User = await res.json();
      router.push(`/home/${user.id}`);
    } catch {
      setRegError("Something went wrong");
    } finally {
      setRegistering(false);
    }
  }

  function resetRegForm() {
    setRegName(""); setRegEmail(""); setRegPw(""); setRegPwConfirm("");
    setRegLevel(4); setRegError(""); setNameAvailable(null);
  }

  return (
    <div className="min-h-screen bg-white pb-24">
      {/* Cover image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/coverpage.png" alt="Mark for You" className="w-full object-cover" />

      <div className="max-w-sm mx-auto px-6">
        {/* Header */}
        <div className="text-center mb-8 pt-6">
          <div className="flex items-center justify-center gap-3 mb-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Mark for You" width={48} height={48} />
            <h1 className="text-3xl font-bold text-slate-800">Mark for You</h1>
          </div>
          <TypingSubheader />
        </div>

        {/* Register buttons */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button
            onClick={() => { setMode(mode === "register-student" ? "idle" : "register-student"); resetRegForm(); }}
            className={`rounded-2xl py-3 px-4 text-center font-semibold border-2 transition-colors ${
              mode === "register-student"
                ? "border-primary-400 bg-primary-50 text-primary-700"
                : "border-slate-200 text-slate-500 hover:border-slate-300"
            }`}
          >
            New Student
          </button>
          <button
            onClick={() => { setMode(mode === "register-parent" ? "idle" : "register-parent"); resetRegForm(); }}
            className={`rounded-2xl py-3 px-4 text-center font-semibold border-2 transition-colors ${
              mode === "register-parent"
                ? "border-accent-orange bg-orange-50 text-orange-700"
                : "border-slate-200 text-slate-500 hover:border-slate-300"
            }`}
          >
            New Parent
          </button>
        </div>

        {/* Registration form */}
        {mode !== "idle" ? (
          <div className="rounded-2xl border-2 border-slate-100 bg-white p-5 mb-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-800 mb-4">
              {mode === "register-student" ? "Create Student Account" : "Create Parent Account"}
            </h2>

            {/* Name */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {mode === "register-student" ? "Username" : "Name"}
              </label>
              <input
                type="text"
                value={regName}
                onChange={(e) => {
                  setRegName(e.target.value);
                  if (mode === "register-student") checkName(e.target.value);
                }}
                placeholder={mode === "register-student" ? "Choose a username" : "Your name"}
                className="w-full px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-primary-400 focus:outline-none"
              />
              {mode === "register-student" && regName.trim() ? (
                <p className={`text-xs mt-1 ${
                  checkingName ? "text-slate-400" :
                  nameAvailable === true ? "text-green-500" :
                  nameAvailable === false ? "text-red-500" : "text-slate-400"
                }`}>
                  {checkingName ? "Checking..." :
                   nameAvailable === true ? "Username available" :
                   nameAvailable === false ? "Username is taken" : ""}
                </p>
              ) : null}
            </div>

            {/* Email (parent only) */}
            {mode === "register-parent" ? (
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-600 mb-1">Email</label>
                <input
                  type="email"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-primary-400 focus:outline-none"
                />
                <p className="text-xs text-slate-400 mt-1">In case you forget your password</p>
              </div>
            ) : null}

            {/* Password */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-600 mb-1">Password</label>
              <input
                type="password"
                value={regPw}
                onChange={(e) => setRegPw(e.target.value)}
                placeholder="Choose a password"
                className="w-full px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-primary-400 focus:outline-none"
              />
            </div>

            {/* Confirm password */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-600 mb-1">Confirm Password</label>
              <input
                type="password"
                value={regPwConfirm}
                onChange={(e) => setRegPwConfirm(e.target.value)}
                placeholder="Re-enter password"
                className={`w-full px-4 py-2.5 rounded-xl border-2 focus:outline-none ${
                  regPwConfirm && regPw !== regPwConfirm
                    ? "border-red-300 focus:border-red-400"
                    : "border-slate-200 focus:border-primary-400"
                }`}
              />
              {regPwConfirm && regPw !== regPwConfirm ? (
                <p className="text-xs text-red-500 mt-1">Passwords don&apos;t match</p>
              ) : null}
            </div>

            {/* Level (student only) */}
            {mode === "register-student" ? (
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-600 mb-1">Level</label>
                <div className="grid grid-cols-6 gap-1.5">
                  {[1, 2, 3, 4, 5, 6].map((l) => (
                    <button
                      key={l}
                      onClick={() => setRegLevel(l)}
                      className={`rounded-lg py-2 text-center text-sm font-semibold border-2 transition-colors ${
                        regLevel === l
                          ? "border-primary-400 bg-primary-50 text-primary-700"
                          : "border-slate-200 text-slate-500 hover:border-slate-300"
                      }`}
                    >
                      P{l}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {regError ? (
              <p className="text-sm text-red-500 mb-3">{regError}</p>
            ) : null}

            <button
              onClick={handleRegister}
              disabled={registering || (mode === "register-student" && nameAvailable === false)}
              className={`w-full py-3 rounded-xl text-white font-semibold transition-colors disabled:opacity-50 ${
                mode === "register-student"
                  ? "bg-primary-600 hover:bg-primary-700"
                  : "bg-accent-orange hover:bg-orange-600"
              }`}
            >
              {registering ? "Creating account..." : "Create Account"}
            </button>
          </div>
        ) : null}

        {/* Divider */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs font-medium text-slate-400 uppercase">Login</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>

        {/* Login form */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Name or Email</label>
            <input
              type="text"
              value={loginId}
              onChange={(e) => { setLoginId(e.target.value); setLoginError(""); }}
              placeholder="Enter your name or email"
              className="w-full px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-primary-400 focus:outline-none"
              onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Password</label>
            <input
              type="password"
              value={loginPw}
              onChange={(e) => { setLoginPw(e.target.value); setLoginError(""); }}
              placeholder="Enter your password"
              className="w-full px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-primary-400 focus:outline-none"
              onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
            />
          </div>

          {loginError ? (
            <p className="text-sm text-red-500">{loginError}</p>
          ) : null}

          <button
            onClick={handleLogin}
            disabled={loggingIn || !loginId.trim() || !loginPw}
            className="w-full py-3 rounded-xl bg-slate-800 text-white font-semibold hover:bg-slate-900 transition-colors disabled:opacity-50"
          >
            {loggingIn ? "Logging in..." : "Log In"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Animated typing subheader ───────────────────────────────────────────────

const PHRASES = [
  "Let AI help with your child's learning gaps.",
  "Let AI grade your child's test",
  "Let AI create focused test",
  "Let AI narrate your child's Spelling / \u542C\u5199",
];

function TypingSubheader() {
  const [text, setText] = useState(PHRASES[0]);
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [phase, setPhase] = useState<"display" | "deleting" | "typing">("display");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const current = PHRASES[phraseIdx];
    const next = PHRASES[(phraseIdx + 1) % PHRASES.length];

    if (phase === "display") {
      // Pause before starting to delete
      timeoutRef.current = setTimeout(() => setPhase("deleting"), 2500);
    } else if (phase === "deleting") {
      // Find common prefix to keep (e.g. "Let AI ")
      let common = 0;
      while (common < text.length && common < next.length && text[common] === next[common]) {
        common++;
      }
      if (text.length > common) {
        timeoutRef.current = setTimeout(() => setText((t) => t.slice(0, -1)), 30);
      } else {
        setPhase("typing");
      }
    } else if (phase === "typing") {
      if (text.length < next.length) {
        timeoutRef.current = setTimeout(() => setText(next.slice(0, text.length + 1)), 50);
      } else {
        setPhraseIdx((i) => (i + 1) % PHRASES.length);
        setPhase("display");
      }
    }

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [text, phase, phraseIdx]);

  return (
    <p className="text-slate-600 text-base font-medium mt-2 h-6">
      {text}
      <span className="inline-block w-[2px] h-3.5 bg-slate-400 ml-0.5 align-text-bottom animate-pulse" />
    </p>
  );
}
