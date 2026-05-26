"use client";

import { Suspense, useState, useRef, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function SignupPage() {
  return (
    <Suspense>
      <SignupFlow />
    </Suspense>
  );
}

function SignupFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialStep = searchParams.get("step");

  // Onboarding routes the parent to /signup?parentId=…&step=2 when
  // they pick 'platform quiz' from the post-questionnaire diagnosis
  // card. Resume there with the parentId already known.
  const initialParentIdParam = searchParams.get("parentId");
  // 'printable' mode means: create the diagnostic quiz the same way,
  // but instead of taking the student into the on-screen quiz we
  // download the printable PDF + show a remind-to-email popup.
  // Legacy mode flag — only "scan-email" still has meaning; printable
  // was removed so callers passing mode=printable just fall through to
  // the standard platform-quiz flow.
  const diagnosticMode = searchParams.get("mode"); // "platform-quiz" | "scan-email" | null
  const scanEmailMode = diagnosticMode === "scan-email";
  const [step, setStep] = useState<1 | 2 | 3>(
    initialParentIdParam && initialStep === "2" ? 2
      : initialParentIdParam && initialStep === "3" ? 3
      : 1
  );

  // ── Step 1: Parent state ──
  // parentFullName → User.displayName (mutable, shown in greetings)
  // parentName     → User.name (immutable login username, unique)
  const [parentFullName, setParentFullName] = useState("");
  const [parentName, setParentName] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [parentPassword, setParentPassword] = useState("");
  const [parentShowPw, setParentShowPw] = useState(false);
  const [parentError, setParentError] = useState("");
  const [parentLoading, setParentLoading] = useState(false);
  const [parentId, setParentId] = useState<string | null>(initialParentIdParam);

  // ── Step 2: Student state ──
  // Username + password are intentionally left blank — parents pick
  // them fresh on the form. Level pre-fills from the parent's
  // onboarding answer (settings.defaultChildLevel) when the wizard
  // is resumed via /signup?parentId=…&step=2.
  const [studentName, setStudentName] = useState("");
  const [studentPassword, setStudentPassword] = useState("");
  const [studentPwConfirm, setStudentPwConfirm] = useState("");
  const [studentLevel, setStudentLevel] = useState(4);

  useEffect(() => {
    if (!initialParentIdParam) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/users?userId=${initialParentIdParam}`);
        if (!r.ok) return;
        const u = await r.json();
        const lvl = (u?.settings as Record<string, unknown> | null)?.defaultChildLevel;
        if (alive && typeof lvl === "number" && lvl >= 1 && lvl <= 6) {
          setStudentLevel(lvl);
        }
      } catch { /* non-fatal */ }
    })();
    return () => { alive = false; };
  }, [initialParentIdParam]);
  const [studentError, setStudentError] = useState("");
  const [studentLoading, setStudentLoading] = useState(false);
  const [studentId, setStudentId] = useState<string | null>(null);

  // ── Step 1: Parent name/email availability ──
  const [parentNameAvail, setParentNameAvail] = useState<boolean | null>(null);
  const [checkingParentName, setCheckingParentName] = useState(false);
  const parentNameDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkParentName = useCallback((n: string) => {
    if (parentNameDebounce.current) clearTimeout(parentNameDebounce.current);
    if (!n.trim()) { setParentNameAvail(null); return; }
    setCheckingParentName(true);
    parentNameDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/check?name=${encodeURIComponent(n.trim())}`);
        const data = await res.json();
        setParentNameAvail(data.available);
      } catch { setParentNameAvail(null); }
      finally { setCheckingParentName(false); }
    }, 400);
  }, []);

  const [parentEmailAvail, setParentEmailAvail] = useState<boolean | null>(null);
  const [checkingParentEmail, setCheckingParentEmail] = useState(false);
  const parentEmailDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Simple RFC-5322-ish email shape check — enough to catch obviously bad input.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const [parentEmailInvalid, setParentEmailInvalid] = useState(false);
  const checkParentEmail = useCallback((em: string) => {
    if (parentEmailDebounce.current) clearTimeout(parentEmailDebounce.current);
    const trimmed = em.trim();
    if (!trimmed) { setParentEmailAvail(null); setParentEmailInvalid(false); return; }
    if (!EMAIL_RE.test(trimmed)) {
      setParentEmailAvail(null);
      setParentEmailInvalid(true);
      setCheckingParentEmail(false);
      return;
    }
    setParentEmailInvalid(false);
    setCheckingParentEmail(true);
    parentEmailDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/check?email=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        setParentEmailAvail(data.available);
      } catch { setParentEmailAvail(null); }
      finally { setCheckingParentEmail(false); }
    }, 400);
  }, []);

  // ── Step 2: Student username availability ──
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

  // ── Step 3: Diagnostic quiz state ──
  const [quizLoading, setQuizLoading] = useState<string | null>(null); // "math" | "science" | "english"
  const [diagnosticType, setDiagnosticType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [diagnosticSubject, setDiagnosticSubject] = useState<"math" | "science" | "english" | null>(null);
  // Progressive = adaptive (starts easier, unlocks full range at >80% avg).
  // Standard = top-schools difficulty (full range, current default).
  const [diagnosticDifficulty, setDiagnosticDifficulty] = useState<"adaptive" | "standard">("standard");

  // ── Step 1 handler ──
  async function handleParentSignup(e: React.FormEvent) {
    e.preventDefault();
    setParentError("");
    if (!parentFullName.trim()) { setParentError("Full name is required."); return; }
    if (parentFullName.trim().length < 2) { setParentError("Full name is too short."); return; }
    if (!parentEmail.trim()) { setParentError("Email is required."); return; }
    if (!EMAIL_RE.test(parentEmail.trim())) { setParentError("Please enter a valid email address."); return; }
    if (parentEmailAvail === false) { setParentError("This email is already registered."); return; }
    if (!parentPassword) { setParentError("Password is required."); return; }

    // Derive a default username from the email local part. Strip
    // anything past + (gmail aliases) and any non-alphanumeric.
    // Backend appends _2 / _3 etc. if it's taken.
    const localPart = parentEmail.trim().split("@")[0].split("+")[0].toLowerCase();
    const derivedName = localPart.replace(/[^a-z0-9_]/g, "").slice(0, 30) || "user";

    setParentLoading(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: derivedName,
          displayName: parentFullName.trim(),
          role: "PARENT",
          email: parentEmail.trim(),
          password: parentPassword,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setParentError(data.error || "Registration failed");
        return;
      }
      const user = await res.json();
      // Replaces the legacy step 2/3 flow (separate student-creation
      // form + diagnostic-quiz subject picker). The new onboarding
      // gathers four lightweight preference questions and lands the
      // parent on the home dashboard, where they create the student
      // account from the same flow that's used for additional kids.
      router.push(`/onboarding/${user.id}`);
    } catch {
      setParentError("Something went wrong. Please try again.");
    } finally {
      setParentLoading(false);
    }
  }

  // ── Step 2 handler ──
  async function handleStudentSignup(e: React.FormEvent) {
    e.preventDefault();
    setStudentError("");
    if (!studentName.trim()) { setStudentError("Username is required."); return; }
    if (!studentPassword) { setStudentError("Password is required."); return; }
    if (studentPassword !== studentPwConfirm) { setStudentError("Passwords don't match."); return; }
    if (nameAvailable === false) { setStudentError("Username is already taken."); return; }

    setStudentLoading(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: studentName.trim(),
          role: "STUDENT",
          password: studentPassword,
          level: studentLevel,
          parentId: parentId || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setStudentError(data.error || "Registration failed");
        return;
      }
      const user = await res.json();
      setStudentId(user.id);
      // Scan-email parents skip the diagnostic-quiz subject picker —
      // they're going to email a paper in instead. Push them to the
      // home dashboard with the popup explaining what to do next.
      if (scanEmailMode && parentId) {
        router.push(`/home/${parentId}?diagnostic=scan-email`);
        return;
      }
      setStep(3);
      setTimeout(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }), 50);
    } catch {
      setStudentError("Something went wrong. Please try again.");
    } finally {
      setStudentLoading(false);
    }
  }

  // ── Step 3: Create diagnostic quiz ──
  async function handleStartQuiz(subject: "math" | "science" | "english") {
    if (!parentId || !studentId) return;
    setQuizLoading(subject);
    try {
      // Persist the difficulty choice on the student so the filter applies
      // to this diagnostic AND every subsequent quiz/focused practice.
      // Parent can change it later in Student Settings.
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: studentId, settings: { questionDifficulty: diagnosticDifficulty } }),
      }).catch(() => { /* non-fatal — quiz still launches on standard default */ });

      const body: Record<string, unknown> = {
        userId: parentId,
        studentId,
        quizType: diagnosticType,
        subject,
      };
      if (subject === "english") {
        const sections = ["grammar-mcq", "vocab-mcq"];
        if (diagnosticType === "mcq-oeq") {
          sections.push("editing", "comprehension-cloze");
        }
        body.englishSections = sections;
      }

      const res = await fetch("/api/daily-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to create quiz");
        setQuizLoading(null);
        return;
      }
      const quiz = await res.json();
      // Navigate the current tab into the student quiz; the quiz
      // review page will surface a 'Open parent homepage' button after
      // submission.
      router.push(`/quiz/${quiz.id}?userId=${studentId}&diagnostic=1&parentId=${parentId}`);
    } catch {
      alert("Something went wrong. Please try again.");
      setQuizLoading(null);
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#f8f9ff", fontFamily: "'Inter', sans-serif" }}>
      {/* ── Header ── */}
      <header className="w-full top-0 sticky z-50" style={{ background: "#f8f9ff" }}>
        <div className="flex justify-between items-center px-6 py-4 max-w-7xl mx-auto">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="MarkForYou.com" className="h-10 w-auto" src="/logo_t.png" />
            <span className="text-lg font-bold tracking-tight" style={{ fontFamily: "var(--font-jakarta), sans-serif", color: "#001e40" }}>
              MarkForYou.com
            </span>
          </Link>
          <div className="flex items-center gap-4">
            {/* Top-right back. Step 1 → home; step 2/3 → previous step.
                Mirrors the bottom Back button in step 2 so users on
                step 1 (who have no bottom Back) still have one. */}
            <button
              type="button"
              onClick={() => {
                if (step === 1) { window.location.href = "/"; return; }
                if (step === 2) { setStep(1); return; }
                if (step === 3) { setStep(2); return; }
              }}
              className="text-sm font-semibold hover:underline flex items-center gap-1"
              style={{ color: "#001e40" }}
            >
              <span className="material-symbols-outlined text-base">arrow_back</span>
              Back
            </button>
            <Link
              href="/login"
              className="text-sm font-semibold hover:underline"
              style={{ color: "#001e40" }}
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="flex-grow flex flex-col items-center justify-center max-w-7xl mx-auto w-full px-6 py-8">

        {/* ══════════ STEP 1: Parent Sign Up ══════════ */}
        {step === 1 && (
          <section className="w-full flex flex-col lg:flex-row gap-12 items-center justify-center pt-8 lg:pt-4">
            {/* Form */}
            <div className="w-full lg:max-w-md space-y-8 order-2 lg:order-1">
              <header className="space-y-4">
                <span
                  className="inline-block py-1 px-3 rounded-full text-xs font-bold mb-4"
                  style={{ background: "#6cf8bb", color: "#002113" }}
                >
                  STEP 01
                </span>
                <h1
                  className="text-4xl lg:text-5xl font-extrabold tracking-tight leading-tight"
                  style={{ fontFamily: "var(--font-jakarta), sans-serif", color: "#0b1c30" }}
                >
                  A warm welcome <br />
                  <span className="italic font-medium" style={{ color: "#006c49" }}>to parents</span>
                </h1>
                <p className="font-bold text-sm" style={{ color: "#006c49" }}>
                  Free for 30 days, no card required.
                </p>
                <p className="leading-relaxed text-lg max-w-sm" style={{ color: "#43474f" }}>
                  Let&apos;s begin your child&apos;s educational journey with insight and calm.
                </p>
              </header>

              <form className="space-y-6" onSubmit={handleParentSignup} autoComplete="off">
                <div className="grid grid-cols-1 gap-6">
                  {/* Full Name (display) */}
                  <div className="space-y-2">
                    <label className="text-sm font-semibold px-1" style={{ color: "rgba(11,28,48,0.8)" }}>
                      Full Name
                      <span className="font-normal text-xs ml-2" style={{ color: "rgba(11,28,48,0.35)" }}>How we&apos;ll greet you. Can be changed later.</span>
                    </label>
                    <input
                      type="text"
                      value={parentFullName}
                      onChange={e => setParentFullName(e.target.value)}
                      placeholder="e.g. Sarah Lim"
                      autoComplete="name"
                      className="w-full px-5 py-4 border-0 rounded-xl transition-all duration-200"
                      style={{
                        background: "#eff4ff",
                        color: "#0b1c30",
                        outline: "none",
                      }}
                    />
                  </div>

                  {/* Username dropped from signup — derived from
                      email (local part) on submit; backend appends _2,
                      _3 on collision. Parent can edit later in /account. */}

                  {/* Email */}
                  <div className="space-y-2">
                    <label className="text-sm font-semibold px-1 flex items-center gap-2" style={{ color: "rgba(11,28,48,0.8)" }}>
                      Email Address
                      <span className="font-normal text-xs" style={{ color: "rgba(11,28,48,0.35)" }}>For password recovery. We may send feature updates for Beta.</span>
                    </label>
                    <input
                      type="email"
                      value={parentEmail}
                      onChange={e => { setParentEmail(e.target.value); checkParentEmail(e.target.value); }}
                      placeholder="sarah@example.com"
                      className="w-full px-5 py-4 border-0 rounded-xl transition-all duration-200"
                      style={{ background: "#eff4ff", color: "#0b1c30" }}
                    />
                    {parentEmail.trim() && (
                      <p className={`text-xs mt-1 ml-1 ${
                        parentEmailInvalid ? "text-red-500"
                        : checkingParentEmail ? "text-gray-400"
                        : parentEmailAvail === true ? "text-green-600"
                        : parentEmailAvail === false ? "text-red-500"
                        : "text-gray-400"
                      }`}>
                        {parentEmailInvalid
                          ? "Please enter a valid email address"
                          : checkingParentEmail ? "Checking..."
                          : parentEmailAvail === true ? "Email available"
                          : parentEmailAvail === false ? "Email is already registered"
                          : ""}
                      </p>
                    )}
                  </div>

                  {/* Password */}
                  <div className="space-y-2">
                    <label className="text-sm font-semibold px-1" style={{ color: "rgba(11,28,48,0.8)" }}>
                      Create Password
                    </label>
                    <div className="relative">
                      <input
                        type={parentShowPw ? "text" : "password"}
                        value={parentPassword}
                        onChange={e => setParentPassword(e.target.value)}
                        placeholder="••••••••"
                        name="mfy-new-password"
                        autoComplete="new-password"
                        className="w-full px-5 py-4 border-0 rounded-xl transition-all duration-200"
                        style={{ background: "#eff4ff", color: "#0b1c30" }}
                      />
                      <button
                        type="button"
                        onClick={() => setParentShowPw(v => !v)}
                        className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer"
                        style={{ color: "#c3c6d1" }}
                      >
                        <span className="material-symbols-outlined">
                          {parentShowPw ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                {parentError && (
                  <p className="text-sm font-medium" style={{ color: "#ba1a1a" }}>{parentError}</p>
                )}

                <button
                  type="submit"
                  disabled={parentLoading || !parentFullName.trim() || parentEmailAvail === false || parentEmailInvalid || !parentEmail.trim() || !parentPassword}
                  className="w-full py-5 px-8 rounded-xl font-bold text-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all duration-300 flex items-center justify-center gap-2 group disabled:opacity-60"
                  style={{ background: "linear-gradient(to bottom right, #001e40, #003366)", color: "#ffffff" }}
                >
                  {parentLoading ? "Creating account..." : "Get Started"}
                  {!parentLoading && (
                    <span className="material-symbols-outlined group-hover:translate-x-1 transition-transform">arrow_forward</span>
                  )}
                </button>

                {/* OAuth signup — same providers as login. The signIn
                    callback (src/lib/auth.ts) auto-creates a User
                    with a 30-day trial when it sees a brand-new
                    email, so no separate "OAuth signup" route is
                    needed. */}
                <div className="relative flex items-center my-2">
                  <div className="flex-grow border-t border-slate-200" />
                  <span className="px-3 text-xs font-medium text-slate-500">or</span>
                  <div className="flex-grow border-t border-slate-200" />
                </div>
                {/* Apple web sign-in disabled — see same note in
                    /login: SameSite=None cookies required for Apple
                    were breaking Google on privacy-strict browsers.
                    iOS app users still get Apple via native plugin. */}
                <div className="grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    onClick={() => signIn("google", { redirectTo: "/post-login" })}
                    className="flex items-center justify-center gap-2 py-3 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 transition-colors font-bold text-sm text-slate-700"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                    Continue with Google
                  </button>
                </div>

                <p className="text-center text-sm" style={{ color: "#43474f" }}>
                  Already have an account?{" "}
                  <Link href="/login" className="font-bold hover:underline" style={{ color: "#001e40" }}>
                    Sign in
                  </Link>
                </p>
              </form>
            </div>

            {/* Illustration */}
            <div className="w-full lg:max-w-xl flex flex-col items-center justify-center relative order-1 lg:order-2">
              <div className="relative w-full aspect-square max-w-lg">
                <div className="absolute inset-0 rounded-full blur-3xl opacity-50 -z-10"
                  style={{ background: "linear-gradient(to top right, rgba(108,248,187,0.2), rgba(213,227,255,0.3))" }}
                />
                <div className="w-full h-full rounded-[4rem] overflow-hidden shadow-2xl relative border-[12px]"
                  style={{ borderColor: "#ffffff" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="w-full h-full object-cover"
                    alt="Mother and child learning together"
                    src="/step1.png"
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ══════════ STEP 2: Student Sign Up ══════════ */}
        {step === 2 && (
          <div className="w-full flex flex-col lg:flex-row items-center gap-6 lg:gap-24 pt-4 lg:pt-8">
            {/* Form */}
            <div className="w-full lg:w-1/2 space-y-8 order-2 lg:order-1">
              <div className="space-y-4">
                <div
                  className="inline-flex items-center gap-2 px-3 py-1 rounded-full font-bold text-xs tracking-widest uppercase"
                  style={{ background: "#6cf8bb", color: "#006c49" }}
                >
                  Step 02
                </div>
                <h1
                  className="text-4xl lg:text-5xl font-extrabold leading-tight"
                  style={{ fontFamily: "var(--font-jakarta), sans-serif", color: "#001e40" }}
                >
                  Tell us about your student
                </h1>
                <p className="text-lg leading-relaxed max-w-md" style={{ color: "#43474f" }}>
                  Create a dedicated space for your child to explore, learn, and grow at their own pace.
                </p>
              </div>

              <form className="space-y-6" onSubmit={handleStudentSignup} autoComplete="off">
                {/* Username */}
                <div className="space-y-2">
                  <label className="text-sm font-semibold ml-1" style={{ color: "#0b1c30" }}>
                    Child&apos;s username
                  </label>
                  <input
                    type="text"
                    value={studentName}
                    onChange={e => { setStudentName(e.target.value); checkName(e.target.value); }}
                    placeholder="e.g. SpaceExplorer123"
                    name="mfy-student-username"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full px-6 py-4 rounded-xl border-0 outline-none transition-all"
                    style={{
                      background: "#eff4ff",
                      boxShadow: "inset 0 0 0 1px rgba(195,198,209,0.2)",
                      color: "#0b1c30",
                    }}
                  />
                  {studentName.trim() && (
                    <p className={`text-xs ml-1 ${checkingName ? "text-gray-400" : nameAvailable === true ? "text-green-600" : nameAvailable === false ? "text-red-500" : "text-gray-400"}`}>
                      {checkingName ? "Checking..." : nameAvailable === true ? "Username available ✓" : nameAvailable === false ? "Username is taken" : ""}
                    </p>
                  )}
                </div>

                {/* Grade Level */}
                <div className="space-y-3">
                  <label className="text-sm font-semibold ml-1" style={{ color: "#0b1c30" }}>Grade Level</label>
                  <div className="flex gap-3">
                    {[3, 4, 5, 6].map(l => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setStudentLevel(l)}
                        className="flex-1 py-4 rounded-xl font-bold transition-all"
                        style={{
                          background: studentLevel === l ? "#d3e4fe" : "#eff4ff",
                          color: studentLevel === l ? "#001e40" : "#43474f",
                          boxShadow: studentLevel === l ? "inset 0 0 0 2px #001e40" : "none",
                        }}
                      >
                        P{l}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Passwords */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold ml-1" style={{ color: "#0b1c30" }}>
                      Student Access Password
                    </label>
                    <input
                      type="password"
                      value={studentPassword}
                      onChange={e => setStudentPassword(e.target.value)}
                      placeholder="••••••••"
                      name="mfy-student-password"
                      autoComplete="new-password"
                      className="w-full px-6 py-4 rounded-xl border-0 outline-none transition-all"
                      style={{ background: "#eff4ff", boxShadow: "inset 0 0 0 1px rgba(195,198,209,0.2)", color: "#0b1c30" }}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold ml-1" style={{ color: "#0b1c30" }}>
                      Confirm Password
                    </label>
                    <input
                      type="password"
                      value={studentPwConfirm}
                      onChange={e => setStudentPwConfirm(e.target.value)}
                      name="mfy-student-pw-confirm"
                      autoComplete="new-password"
                      placeholder="••••••••"
                      className="w-full px-6 py-4 rounded-xl border-0 outline-none transition-all"
                      style={{ background: "#eff4ff", boxShadow: "inset 0 0 0 1px rgba(195,198,209,0.2)", color: "#0b1c30" }}
                    />
                  </div>
                </div>
                {studentPwConfirm && studentPassword !== studentPwConfirm && (
                  <p className="text-xs text-red-500 -mt-3 ml-1">Passwords don&apos;t match</p>
                )}

                {studentError && (
                  <p className="text-sm font-medium" style={{ color: "#ba1a1a" }}>{studentError}</p>
                )}

                {/* Actions */}
                <div className="pt-4 flex flex-col md:flex-row items-center gap-4">
                  <button
                    type="submit"
                    disabled={studentLoading || nameAvailable === false}
                    className="w-full md:w-auto px-10 py-4 text-white font-bold rounded-xl shadow-lg hover:shadow-xl transition-all transform hover:-translate-y-0.5 active:scale-95 disabled:opacity-60"
                    style={{ background: "linear-gradient(to right, #001e40, #003366)" }}
                  >
                    {studentLoading ? "Creating..." : "Create Student Profile"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="w-full md:w-auto px-6 py-4 font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                    style={{ color: "#001e40" }}
                  >
                    <span className="material-symbols-outlined text-sm">arrow_back</span>
                    Back
                  </button>
                </div>
              </form>
            </div>

          </div>
        )}

        {/* ══════════ STEP 3: Diagnostic Quiz ══════════ */}
        {step === 3 && (
          <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 relative overflow-hidden w-full">
            {/* Background glow */}
            <div className="absolute inset-0 -z-10" style={{ background: "radial-gradient(circle at center, rgba(111,251,190,0.15) 0%, rgba(211,228,254,0.05) 100%)" }} />
            <div className="absolute top-20 right-40 w-96 h-96 rounded-full blur-[120px]" style={{ background: "rgba(108,248,187,0.2)" }} />
            <div className="absolute bottom-20 left-40 w-80 h-80 rounded-full blur-[100px]" style={{ background: "rgba(211,228,254,0.3)" }} />

            <div className="max-w-7xl w-full grid grid-cols-1 lg:grid-cols-2 gap-12 items-center relative z-10">
              {/* Left content */}
              <div className="text-center lg:text-left">
                {/* Progress */}
                <div className="flex justify-center lg:justify-start mb-8">
                  <div className="px-4 py-1.5 rounded-full flex items-center gap-2" style={{ background: "#dce9ff" }}>
                    <div className="w-2 h-2 rounded-full" style={{ background: "#006c49" }} />
                    <span className="text-xs font-bold uppercase tracking-widest" style={{ color: "#0b1c30" }}>
                      Step 3 of 3 &bull; Completion
                    </span>
                  </div>
                </div>

                <h1
                  className="text-4xl md:text-5xl lg:text-6xl font-extrabold mb-6 tracking-tight"
                  style={{ fontFamily: "var(--font-jakarta), sans-serif", color: "#001e40" }}
                >
                  You are all set!
                </h1>
                <p className="text-lg md:text-xl max-w-2xl lg:max-w-none mb-12 leading-relaxed" style={{ color: "#43474f" }}>
                  To get started, I suggest starting with a{" "}
                  <span className="font-bold" style={{ color: "#006c49" }}>10-15mins quiz</span>{" "}
                  for your child so that our AI can instantly diagnose strengths and weaknesses.
                </p>

                {/* Actions */}
                <div className="flex flex-col gap-6 max-w-2xl mx-auto lg:mx-0">
                  {/* Diagnostic quiz card */}
                  <div
                    className="p-8 rounded-[2.5rem] text-white shadow-2xl flex flex-col md:flex-row items-start justify-between gap-8 text-left relative overflow-hidden"
                    style={{ background: "linear-gradient(to bottom right, #001e40, #003366)" }}
                  >
                    <div className="relative z-10 w-full">
                      <h3 className="text-2xl font-bold mb-2">Start Diagnostic Quiz</h3>
                      <p className="text-white/70 text-sm mb-6">Choose a core subject to begin the discovery journey.</p>
                      <p className="text-white/50 text-[10px] font-semibold uppercase tracking-wider mb-2">1. Pick a subject</p>
                      <div className="flex flex-wrap gap-2 mb-5">
                        {(["math", "science", "english"] as const).map(subj => {
                          const isSelected = diagnosticSubject === subj;
                          return (
                            <button
                              key={subj}
                              onClick={() => setDiagnosticSubject(subj)}
                              disabled={!!quizLoading}
                              className="px-5 py-2.5 backdrop-blur-md rounded-full text-sm font-semibold transition-colors flex items-center gap-2 disabled:opacity-50"
                              style={{
                                background: isSelected ? "rgba(108,248,187,0.3)" : "rgba(255,255,255,0.1)",
                                border: isSelected ? "1px solid rgba(108,248,187,0.8)" : "1px solid rgba(255,255,255,0.1)",
                              }}
                            >
                              {subj === "english" ? (
                                <span className="font-extrabold text-base leading-none">A</span>
                              ) : (
                                <span className="material-symbols-outlined text-sm">
                                  {subj === "math" ? "functions" : "science"}
                                </span>
                              )}
                              {subj.charAt(0).toUpperCase() + subj.slice(1)}
                            </button>
                          );
                        })}
                      </div>
                      {/* Difficulty toggle — persists on the student as
                          settings.questionDifficulty. Progressive = adaptive,
                          Top schools = standard (full range, current default). */}
                      <p className="text-white/50 text-[10px] font-semibold uppercase tracking-wider mb-2">2. Difficulty</p>
                      <div className="flex gap-2 mb-1">
                        <button
                          onClick={() => setDiagnosticDifficulty("adaptive")}
                          className="flex-1 py-2 rounded-lg text-xs font-semibold transition-colors"
                          style={{
                            background: diagnosticDifficulty === "adaptive" ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)",
                            border: diagnosticDifficulty === "adaptive" ? "1px solid rgba(255,255,255,0.4)" : "1px solid rgba(255,255,255,0.1)",
                          }}
                        >
                          Progressive (start easier)
                        </button>
                        <button
                          onClick={() => setDiagnosticDifficulty("standard")}
                          className="flex-1 py-2 rounded-lg text-xs font-semibold transition-colors"
                          style={{
                            background: diagnosticDifficulty === "standard" ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)",
                            border: diagnosticDifficulty === "standard" ? "1px solid rgba(255,255,255,0.4)" : "1px solid rgba(255,255,255,0.1)",
                          }}
                        >
                          Top schools difficulty
                        </button>
                      </div>
                      <p className="text-white/40 text-[10px] mb-5">This setting can be changed later.</p>
                      {/* Quiz type toggle */}
                      <p className="text-white/50 text-[10px] font-semibold uppercase tracking-wider mb-2">3. Pick question type</p>
                      <div className="flex gap-2 mb-5">
                        <button
                          onClick={() => setDiagnosticType("mcq")}
                          className="flex-1 py-2 rounded-lg text-xs font-semibold transition-colors"
                          style={{
                            background: diagnosticType === "mcq" ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)",
                            border: diagnosticType === "mcq" ? "1px solid rgba(255,255,255,0.4)" : "1px solid rgba(255,255,255,0.1)",
                          }}
                        >
                          MCQ Only
                        </button>
                        <button
                          onClick={() => setDiagnosticType("mcq-oeq")}
                          className="flex-1 py-2 rounded-lg text-xs font-semibold transition-colors"
                          style={{
                            background: diagnosticType === "mcq-oeq" ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)",
                            border: diagnosticType === "mcq-oeq" ? "1px solid rgba(255,255,255,0.4)" : "1px solid rgba(255,255,255,0.1)",
                          }}
                        >
                          {diagnosticSubject === "english" ? "MCQ and Cloze" : "MCQ and written"}
                        </button>
                      </div>
                      {diagnosticType === "mcq-oeq" && diagnosticSubject !== "english" && (
                        <p className="text-white/40 text-[10px] mb-3 flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">stylus_note</span>
                          Stylus recommended for written questions
                        </p>
                      )}
                      <button
                        onClick={() => diagnosticSubject && handleStartQuiz(diagnosticSubject)}
                        disabled={!diagnosticSubject || !!quizLoading}
                        className="w-full py-3 rounded-xl text-sm font-bold transition-colors disabled:opacity-40"
                        style={{ background: "#6cf8bb", color: "#001e40" }}
                      >
                        {quizLoading ? "Creating quiz…" : "Start Quiz"}
                      </button>
                    </div>
                  </div>

                  {/* Go to dashboard */}
                  <button
                    onClick={() => router.push(`/home/${parentId}`)}
                    className="w-full px-8 py-5 rounded-xl font-bold text-lg shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 flex items-center justify-center gap-2"
                    style={{ background: "#006c49", color: "#ffffff" }}
                  >
                    Go to Parent Homepage
                    <span className="material-symbols-outlined">arrow_forward</span>
                  </button>
                </div>
              </div>

              {/* Right illustration */}
              <div className="hidden lg:flex justify-center items-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt="Celebratory learning moment"
                  className="w-full max-w-lg drop-shadow-2xl"
                  src="/step3.png"
                  style={{ borderRadius: "40px" }}
                />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="w-full py-8 px-6 text-xs mt-auto" style={{ color: "rgba(11,28,48,0.4)" }}>
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-4">
            <p>&copy; 2025 MarkForYou.com</p>
            <span className="w-1 h-1 rounded-full" style={{ background: "#c3c6d1" }} />
            <Link className="hover:underline" href="/privacy">Privacy Policy</Link>
            <span className="w-1 h-1 rounded-full" style={{ background: "#c3c6d1" }} />
            <Link className="hover:underline" href="/terms">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
