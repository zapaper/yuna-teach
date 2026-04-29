"use client";

import { use, useEffect, useState, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Post-signup onboarding for new parent accounts. Four bubble-style
// multiple-choice questions, each animated in from the right and out
// to the left as the parent picks an answer. Final answers persist to
// parent.settings; the child's level is also written through to the
// linked student record if there is one. After the last question we
// show a brief "all set" confirmation before pushing to the home page.

type Answers = {
  studyMode?: "paper" | "mixed" | "both";
  focusDuration?: "short" | "long";
  questionDifficulty?: "adaptive" | "standard" | "hard";
  childLevel?: 4 | 5 | 6;
};

type Question = {
  key: keyof Answers;
  preamble?: string;
  prompt: string;
  options: { value: string | number; label: string; sub?: string }[];
};

const QUESTIONS: Question[] = [
  {
    key: "studyMode",
    preamble: "Hi there! We'll ask a few quick questions so we can tailor MarkForYou to your child's learning needs.",
    prompt: "First, which best describes how you'd like your child to study?",
    options: [
      { value: "paper", label: "Mostly on paper", sub: "Print worksheets, minimise screen time." },
      { value: "mixed", label: "Mix of paper and screen", sub: "Some homework on tablet/PC, some on paper." },
      { value: "both", label: "Comfortable with both", sub: "Either format works equally well." },
    ],
  },
  {
    key: "focusDuration",
    preamble: "Excellent!",
    prompt: "What is the typical duration your child can focus on a piece of work before needing a break?",
    options: [
      { value: "short", label: "5–20 minutes" },
      { value: "medium", label: "20–40 minutes" },
      { value: "long", label: "40–60 minutes" },
    ],
  },
  {
    key: "questionDifficulty",
    prompt: "What kind of question difficulty best suits your child at this point?",
    options: [
      { value: "adaptive", label: "Start easy and progress as they gain mastery" },
      { value: "standard", label: "Top school standards" },
      { value: "hard", label: "Only the hard questions from the top schools" },
    ],
  },
  {
    key: "childLevel",
    preamble: "Thank you.",
    prompt: "Now, please tell us about your child's level.",
    options: [
      { value: 4, label: "Primary 4" },
      { value: 5, label: "Primary 5" },
      { value: 6, label: "Primary 6" },
    ],
  },
];

const TOTAL_STEPS = QUESTIONS.length;

export default function OnboardingPage({ params }: { params: Promise<{ parentId: string }> }) {
  const { parentId } = use(params);
  const router = useRouter();
  const sp = useSearchParams();
  const studentId = sp.get("studentId");

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  // Phases: in (sliding in from the right), idle (sitting on screen),
  // out (sliding off to the left after a pick). The transition timing
  // matches the CSS classes below — change one, change the other.
  const [phase, setPhase] = useState<"in" | "idle" | "out">("in");
  const [done, setDone] = useState(false);
  const [showDiagnosisChoice, setShowDiagnosisChoice] = useState(false);
  // Q5 — student creation moved INTO onboarding so the parent flows
  // through one continuous experience instead of bouncing back to the
  // legacy /signup wizard. After diagnosisChoice is set, we transition
  // to studentStep, then route to /home with the diagnostic mode.
  const [diagnosisChoice, setDiagnosisChoice] = useState<"scan-email" | "platform-quiz" | "printable" | null>(null);
  const [studentStep, setStudentStep] = useState(false);
  const [studentName, setStudentName] = useState("");
  const [studentPassword, setStudentPassword] = useState("");
  const [studentPwConfirm, setStudentPwConfirm] = useState("");
  const [studentNameAvailable, setStudentNameAvailable] = useState<boolean | null>(null);
  const [checkingStudentName, setCheckingStudentName] = useState(false);
  const [studentError, setStudentError] = useState("");
  const [studentLoading, setStudentLoading] = useState(false);
  const studentNameDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkStudentName = useCallback((n: string) => {
    if (studentNameDebounce.current) clearTimeout(studentNameDebounce.current);
    if (!n.trim()) { setStudentNameAvailable(null); return; }
    setCheckingStudentName(true);
    studentNameDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/check?name=${encodeURIComponent(n.trim())}`);
        const data = await res.json();
        setStudentNameAvailable(data.available);
      } catch { setStudentNameAvailable(null); }
      finally { setCheckingStudentName(false); }
    }, 400);
  }, []);
  // Typewriter reveal — preamble + prompt animate in character-by-
  // character at ~20ms per char. Faster than 'classic' typewriter so
  // we don't slow the parent down. Resets on every step change.
  const [typedChars, setTypedChars] = useState(0);
  // Block render until we've checked onboardingCompleted — otherwise
  // a re-signup user briefly sees Q1 before being redirected home.
  const [gated, setGated] = useState(true);

  // Skip onboarding for parents who have already completed it.
  // Manually navigating back to /onboarding/<id> shouldn't ask the
  // four questions again.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/users?userId=${parentId}`);
        if (!res.ok) { if (alive) setGated(false); return; }
        const user = await res.json();
        const completed = (user?.settings as Record<string, unknown> | null)?.onboardingCompleted === true;
        if (completed) {
          router.replace(`/home/${parentId}`);
          return;
        }
      } catch {
        // fall through to showing the onboarding — non-fatal
      }
      if (alive) setGated(false);
    })();
    return () => { alive = false; };
  }, [parentId, router]);

  function pickAnswer(value: string | number) {
    if (phase !== "idle") return;
    const next: Answers = { ...answers, [QUESTIONS[step].key]: value as never };
    setAnswers(next);
    setPhase("out");
    setTimeout(() => {
      if (step === TOTAL_STEPS - 1) {
        void finish(next);
      } else {
        setStep(s => s + 1);
        setPhase("in");
        // Next-frame rAF to let "in" actually be applied as a starting
        // state before flipping to "idle" — otherwise the browser
        // collapses the two and skips the animation.
        requestAnimationFrame(() => requestAnimationFrame(() => setPhase("idle")));
      }
    }, 280);
  }

  // First-mount slide-in.
  if (phase === "in" && step === 0) {
    requestAnimationFrame(() => requestAnimationFrame(() => setPhase("idle")));
  }

  async function finish(allAnswers: Answers) {
    // Persist settings before showing the final card. Parents who
    // selected mostly-paper or mixed-screen-time get a diagnosis-
    // selection screen instead of the simple "All set!"; everyone
    // else proceeds straight to the dashboard.
    try {
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: parentId,
          settings: {
            studyMode: allAnswers.studyMode,
            focusDuration: allAnswers.focusDuration,
            questionDifficulty: allAnswers.questionDifficulty,
            defaultChildLevel: allAnswers.childLevel,
            onboardingCompleted: true,
          },
        }),
      });
      if (studentId) {
        await fetch("/api/users", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: studentId,
            settings: { questionDifficulty: allAnswers.questionDifficulty },
          }),
        });
      }
    } catch {
      // Non-fatal — answers are best-effort.
    }
    setShowDiagnosisChoice(true);
  }

  async function chooseDiagnosis(kind: "scan-email" | "platform-quiz" | "printable") {
    try {
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: parentId,
          settings: { diagnosticChoice: kind },
        }),
      });
    } catch { /* non-fatal */ }
    setDiagnosisChoice(kind);
    // Re-entering onboarding with an existing studentId means the
    // parent already has a child linked — skip Q5 and route straight
    // to home with the diagnostic mode.
    if (studentId) {
      router.replace(`/home/${parentId}?diagnostic=${kind}&studentId=${studentId}`);
      return;
    }
    setShowDiagnosisChoice(false);
    setStudentStep(true);
  }

  async function submitStudent(e: React.FormEvent) {
    e.preventDefault();
    setStudentError("");
    if (!studentName.trim()) { setStudentError("Username is required."); return; }
    if (!studentPassword) { setStudentError("Password is required."); return; }
    if (studentPassword !== studentPwConfirm) { setStudentError("Passwords don't match."); return; }
    if (studentNameAvailable === false) { setStudentError("Username is already taken."); return; }

    setStudentLoading(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: studentName.trim(),
          role: "STUDENT",
          password: studentPassword,
          level: answers.childLevel ?? 4,
          parentId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStudentError(data.error || "Registration failed");
        return;
      }
      const student = await res.json();
      // Persist questionDifficulty on the student so it applies to
      // every quiz/focused practice from here on. The student-side
      // toggle only knows "adaptive" | "standard"; map onboarding's
      // "hard" → "standard" (full top-school range).
      if (answers.questionDifficulty) {
        const studentDifficulty = answers.questionDifficulty === "hard" ? "standard" : answers.questionDifficulty;
        fetch("/api/users", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: student.id, settings: { questionDifficulty: studentDifficulty } }),
        }).catch(() => { /* non-fatal */ });
      }
      const choice = diagnosisChoice ?? "scan-email";
      router.replace(`/home/${parentId}?diagnostic=${choice}&studentId=${student.id}`);
    } catch {
      setStudentError("Something went wrong. Please try again.");
    } finally {
      setStudentLoading(false);
    }
  }

  const q = QUESTIONS[step];
  const fullText = `${q?.preamble ? q.preamble + " " : ""}${q?.prompt ?? ""}`;
  // Reset typewriter on every step change.
  useEffect(() => { setTypedChars(0); }, [step]);
  useEffect(() => {
    if (phase !== "idle") return;
    if (typedChars >= fullText.length) return;
    const t = setTimeout(() => setTypedChars(c => c + 1), 9);
    return () => clearTimeout(t);
  }, [typedChars, fullText, phase]);
  const preambleLen = q?.preamble ? q.preamble.length + 1 : 0; // +1 for separator space
  const typedPreamble = q?.preamble ? q.preamble.slice(0, Math.min(typedChars, q.preamble.length)) : "";
  const typedPrompt = typedChars > preambleLen ? (q?.prompt ?? "").slice(0, typedChars - preambleLen) : "";
  const typingComplete = typedChars >= fullText.length;
  const cardCls =
    "transition-all duration-300 ease-out " +
    (phase === "in" ? "translate-x-8 opacity-0"
      : phase === "out" ? "-translate-x-8 opacity-0"
      : "translate-x-0 opacity-100");

  if (gated) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "linear-gradient(135deg, #f0f5ff 0%, #f8f9ff 60%, #fff 100%)" }}>
        <div className="w-10 h-10 rounded-full border-4 border-[#dce9ff] border-t-[#003366] animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden" style={{ background: "linear-gradient(135deg, #f0f5ff 0%, #f8f9ff 60%, #fff 100%)" }}>
      {/* Decorative blurred blobs — soft brand accent without taking
          attention away from the question card. */}
      <div className="absolute -top-32 -left-24 w-96 h-96 rounded-full pointer-events-none" style={{ background: "rgba(0,51,102,0.08)", filter: "blur(80px)" }} />
      <div className="absolute -bottom-32 -right-24 w-96 h-96 rounded-full pointer-events-none" style={{ background: "rgba(108,248,187,0.20)", filter: "blur(80px)" }} />

      <header className="px-6 pt-6 pb-3 max-w-md mx-auto w-full relative z-10">
        <div className="flex items-center justify-between mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo_t.png" alt="MarkForYou" className="h-7 w-auto" />
          {!done && (step > 0 || showDiagnosisChoice || studentStep) && (
            <button
              onClick={() => {
                // Back from Q5 student form returns to the diagnosis
                // choice card; from the diagnosis card returns to Q4
                // (childLevel); from any question card slides to the
                // previous question.
                if (studentStep) {
                  setStudentStep(false);
                  setShowDiagnosisChoice(true);
                  return;
                }
                if (showDiagnosisChoice) {
                  setShowDiagnosisChoice(false);
                  // Q4's slide animation already finished; reset phase
                  // to idle so the card is fully visible.
                  setPhase("idle");
                  return;
                }
                if (phase !== "idle") return;
                setPhase("out");
                setTimeout(() => {
                  setStep(s => Math.max(0, s - 1));
                  setPhase("in");
                  requestAnimationFrame(() => requestAnimationFrame(() => setPhase("idle")));
                }, 280);
              }}
              className="text-xs font-semibold text-[#43474f] hover:text-[#001e40] flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-base">arrow_back</span>
              Back
            </button>
          )}
        </div>
        {/* Progress bar — 4 questions + diagnosis choice + student
            creation. The diagnosis card and the student form each
            occupy their own tick so the parent can see how much is
            left after the questionnaire. */}
        <div className="flex gap-1.5">
          {Array.from({ length: TOTAL_STEPS + 2 }).map((_, i) => {
            const currentIdx = studentStep ? TOTAL_STEPS + 1
              : showDiagnosisChoice ? TOTAL_STEPS
              : step;
            return (
              <div
                key={i}
                className={`flex-1 h-1.5 rounded-full transition-all duration-500 ${
                  i < currentIdx || done ? "bg-[#003366]" : i === currentIdx ? "bg-[#003366]/40" : "bg-slate-200"
                }`}
              />
            );
          })}
        </div>
        <p className="text-xs text-[#43474f] mt-2 font-medium tracking-wide">
          {done ? "All done"
            : studentStep ? `Step ${TOTAL_STEPS + 2} of ${TOTAL_STEPS + 2}`
            : showDiagnosisChoice ? `Step ${TOTAL_STEPS + 1} of ${TOTAL_STEPS + 2}`
            : `Step ${step + 1} of ${TOTAL_STEPS + 2}`}
        </p>
      </header>

      <main className="flex-1 px-6 max-w-md mx-auto w-full overflow-hidden flex flex-col justify-center pb-12 relative z-10">
        {studentStep ? (
          <div style={{ animation: "popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
            <p className="text-sm font-bold text-[#003366] mb-3 uppercase tracking-wider">Last step</p>
            <h2 className="font-headline font-extrabold text-2xl text-[#001e40] leading-snug mb-3">Set up your child&apos;s login</h2>
            <p className="text-sm text-[#43474f] leading-relaxed mb-6">
              Pick a username and password your child will use to log in to MarkForYou.
            </p>
            <form onSubmit={submitStudent} className="flex flex-col gap-4" autoComplete="off">
              <div>
                <label className="text-xs font-semibold text-[#001e40] mb-1.5 block ml-1">Child&apos;s username</label>
                <input
                  type="text"
                  value={studentName}
                  onChange={e => { setStudentName(e.target.value); checkStudentName(e.target.value); }}
                  placeholder="e.g. SpaceExplorer123"
                  name="mfy-onboarding-student-name"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full px-4 py-3 bg-white border-2 border-[#dce9ff] rounded-2xl text-[#001e40] placeholder-[#c3c6d1] focus:border-[#003366] outline-none transition-colors"
                />
                {studentName.trim() && (
                  <p className={`text-xs mt-1 ml-1 ${
                    checkingStudentName ? "text-gray-400"
                    : studentNameAvailable === true ? "text-green-600"
                    : studentNameAvailable === false ? "text-red-500"
                    : "text-gray-400"
                  }`}>
                    {checkingStudentName ? "Checking..."
                    : studentNameAvailable === true ? "Username available ✓"
                    : studentNameAvailable === false ? "Username is taken"
                    : ""}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-[#001e40] mb-1.5 block ml-1">Password</label>
                  <input
                    type="password"
                    value={studentPassword}
                    onChange={e => setStudentPassword(e.target.value)}
                    placeholder="••••••••"
                    name="mfy-onboarding-student-pw"
                    autoComplete="new-password"
                    className="w-full px-4 py-3 bg-white border-2 border-[#dce9ff] rounded-2xl text-[#001e40] placeholder-[#c3c6d1] focus:border-[#003366] outline-none transition-colors"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-[#001e40] mb-1.5 block ml-1">Confirm</label>
                  <input
                    type="password"
                    value={studentPwConfirm}
                    onChange={e => setStudentPwConfirm(e.target.value)}
                    placeholder="••••••••"
                    name="mfy-onboarding-student-pw-confirm"
                    autoComplete="new-password"
                    className="w-full px-4 py-3 bg-white border-2 border-[#dce9ff] rounded-2xl text-[#001e40] placeholder-[#c3c6d1] focus:border-[#003366] outline-none transition-colors"
                  />
                </div>
              </div>
              {studentPwConfirm && studentPassword !== studentPwConfirm && (
                <p className="text-xs text-red-500 -mt-2 ml-1">Passwords don&apos;t match</p>
              )}
              {studentError && (
                <p className="text-sm font-medium text-[#ba1a1a]">{studentError}</p>
              )}
              <button
                type="submit"
                disabled={studentLoading || studentNameAvailable === false}
                className="w-full mt-2 py-4 px-6 rounded-2xl font-bold text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-60"
                style={{ background: "linear-gradient(to bottom right, #001e40, #003366)" }}
              >
                {studentLoading ? "Creating profile..." : "Create profile"}
              </button>
              <p className="text-xs text-[#43474f] text-center mt-2">
                You can add more students later.
              </p>
            </form>
          </div>
        ) : showDiagnosisChoice ? (() => {
          // Heavy-screen-time parents see two options (platform quiz +
          // email scan); paper / mixed parents also get the printable
          // option since they explicitly want less screen time.
          const screenHeavy = answers.studyMode === "both";
          const optionsLight = [
            {
              key: "platform-quiz" as const,
              icon: "devices",
              title: "15-min quiz on the platform",
              sub: "Quick on-screen diagnostic. Results show up immediately.",
            },
            {
              key: "scan-email" as const,
              icon: "mail",
              title: "Scan and email a recent test",
              sub: (<>Send any past paper (graded or ungraded) to <strong className="text-[#003366] font-semibold">diagnose@inbound.markforyou.com</strong>. Our AI auto-marks and finds the gaps.</>) as React.ReactNode,
            },
          ];
          // Long-focus children + paper/mixed preference → suggest a
          // full past-year paper rather than the short 15-min quiz.
          // The underlying download still uses the printable-quiz path
          // for now; the label change communicates the intent.
          const longFocus = answers.focusDuration === "long";
          const optionsPaper = [
            {
              key: "scan-email" as const,
              icon: "mail",
              title: "Scan and email a recent test",
              sub: (<>Send any past paper (graded or ungraded) to <strong className="text-[#003366] font-semibold">diagnose@inbound.markforyou.com</strong>. Our AI auto-marks and finds the gaps.</>) as React.ReactNode,
            },
            {
              key: "platform-quiz" as const,
              icon: "devices",
              title: "15-min quiz on the platform",
              sub: "Quick on-screen diagnostic. Results show up immediately.",
            },
            longFocus
              ? {
                  key: "printable" as const,
                  icon: "print",
                  title: "Print out a 40-min past year paper",
                  sub: "Download a full past-year paper PDF, your child works on paper, scan it back when done.",
                }
              : {
                  key: "printable" as const,
                  icon: "print",
                  title: "Print out a 15-min quiz",
                  sub: "Download a PDF, your child writes on paper, scan it back when done.",
                },
          ];
          const opts = screenHeavy ? optionsLight : optionsPaper;
          const blurb = screenHeavy
            ? <>We can set a quick 15-min quiz to analyse your child&apos;s current ability in <strong>Math</strong>, <strong>Science</strong> or <strong>English</strong>. Or, if you&apos;d rather use an existing test, scan and email one in.</>
            : <>We need a quick read on where your child is in <strong>Math</strong>, <strong>Science</strong> or <strong>English</strong>. Pick whichever fits best:</>;
          return (
          <div style={{ animation: "popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
            <p className="text-sm font-bold text-[#003366] mb-3 uppercase tracking-wider">Great!</p>
            <h2 className="font-headline font-extrabold text-2xl text-[#001e40] leading-snug mb-4">Let's diagnose your child's current learning</h2>
            <p className="text-sm text-[#43474f] leading-relaxed mb-6">{blurb}</p>
            <div className="flex flex-col gap-3">
              {opts.map((opt, i) => (
                <button
                  key={opt.key}
                  onClick={() => chooseDiagnosis(opt.key)}
                  className="group text-left bg-white border-2 border-[#dce9ff] rounded-2xl p-4 hover:border-[#003366] hover:bg-[#f5f9ff] hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] transition-all"
                  style={{ animation: `slideUp 0.4s ease-out ${0.1 + i * 0.08}s both` }}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-[#dce9ff] group-hover:bg-[#003366] flex items-center justify-center shrink-0 transition-colors">
                      <span className="material-symbols-outlined text-[#003366] group-hover:text-white transition-colors">{opt.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-[#001e40] text-base leading-tight">{opt.title}</p>
                      <p className="text-xs text-[#43474f] mt-1 leading-relaxed">{opt.sub}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <button
              onClick={() => router.replace(`/home/${parentId}`)}
              className="w-full mt-5 text-xs text-[#43474f] font-semibold hover:text-[#001e40]"
            >
              Skip for now — I'll decide later
            </button>
          </div>
          );
        })() : done ? (
          <div className="text-center" style={{ animation: "popIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
            <div className="relative mx-auto w-20 h-20 mb-6">
              {/* Outer ring pulse */}
              <div className="absolute inset-0 rounded-full" style={{ background: "rgba(108,248,187,0.4)", animation: "pulseRing 1.4s ease-out infinite" }} />
              <div className="relative w-20 h-20 rounded-full bg-[#6cf8bb] flex items-center justify-center text-[#006c49] shadow-lg">
                <span className="material-symbols-outlined" style={{ fontSize: 40, fontVariationSettings: "'FILL' 1, 'wght' 700" }}>check</span>
              </div>
            </div>
            <h2 className="font-headline font-extrabold text-3xl text-[#001e40] mb-2">All set! 🎉</h2>
            <p className="text-[#43474f] text-base">Taking you to your dashboard…</p>
          </div>
        ) : (
          <div className={cardCls} key={step}>
            {q.preamble && (
              <p className="text-base text-[#001e40] leading-relaxed mb-3">
                {typedPreamble}
                {!typingComplete && typedChars <= q.preamble.length && (
                  <span className="inline-block w-0.5 h-4 bg-[#001e40] ml-0.5 align-middle" style={{ animation: "blink 0.8s step-end infinite" }} />
                )}
              </p>
            )}
            <h2 className="font-headline font-extrabold text-2xl text-[#001e40] leading-snug mb-7">
              {typedPrompt}
              {!typingComplete && typedChars > preambleLen && (
                <span className="inline-block w-0.5 h-6 bg-[#001e40] ml-0.5 align-middle" style={{ animation: "blink 0.8s step-end infinite" }} />
              )}
            </h2>
            <div className={`flex flex-col gap-3 transition-opacity duration-300 ${typingComplete ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
              {q.options.map((opt, i) => (
                <button
                  key={String(opt.value)}
                  onClick={() => pickAnswer(opt.value)}
                  className="group text-left bg-white border-2 border-[#dce9ff] rounded-2xl p-4 hover:border-[#003366] hover:bg-[#f5f9ff] hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] transition-all"
                  style={typingComplete ? { animation: `slideUp 0.4s ease-out ${0.06 + i * 0.06}s both` } : undefined}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full border-2 border-[#dce9ff] group-hover:border-[#003366] group-hover:bg-[#003366] flex items-center justify-center shrink-0 mt-0.5 transition-all">
                      <span className="material-symbols-outlined text-base text-transparent group-hover:text-white transition-colors" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-[#001e40] text-base leading-tight">{opt.label}</p>
                      {opt.sub && <p className="text-xs text-[#43474f] mt-1 leading-relaxed">{opt.sub}</p>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      <style jsx>{`
        @keyframes popIn {
          0% { opacity: 0; transform: scale(0.85); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes slideUp {
          0% { opacity: 0; transform: translateY(12px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulseRing {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.5); opacity: 0; }
        }
        @keyframes blink {
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
