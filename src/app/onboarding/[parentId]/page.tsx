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
  questionDifficulty?: "adaptive" | "standard" | "hard";
  childLevel?: 4 | 5 | 6;
};

type Question = {
  key: keyof Answers;
  preamble?: string;
  prompt: string;
  options: { value: string | number; label: string; sub?: string }[];
};

// Question 1 (questionDifficulty) removed — parents now inherit the
// "adaptive" default so we skip the friction of asking. Primary 3
// dropped from the level options since we don't have P3 content.
const QUESTIONS: Question[] = [
  {
    key: "childLevel",
    preamble: "Hi there! Help us tailor MarkForYou to your child.",
    prompt: "Please tell us your child's level.",
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
  // After the two preference questions we show a quiz picker (subject
  // + question type). Difficulty inherits from Q1, so the picker only
  // captures what's not already known.
  const [showQuizPicker, setShowQuizPicker] = useState(false);
  const [pickerSubject, setPickerSubject] = useState<"math" | "science" | "english" | null>(null);
  const [pickerType, setPickerType] = useState<"mcq" | "mcq-oeq">("mcq");
  // Scan-email option removed 2026-07-02 — nobody used it and it
  // muddled the picker CTA hierarchy.
  // "Assign and Email Link" confirmation popup — holds the studentId
  // we just assigned to so we can pass it through firstAssignStudent
  // when the parent picks "Go to homepage".
  const [assignedConfirmationSid, setAssignedConfirmationSid] = useState<string | null>(null);
  // Student-creation step (final card before we route to /home).
  const [studentStep, setStudentStep] = useState(false);
  const [studentName, setStudentName] = useState("");
  const [studentPassword, setStudentPassword] = useState("");
  const [studentPwConfirm, setStudentPwConfirm] = useState("");
  const [studentNameAvailable, setStudentNameAvailable] = useState<boolean | null>(null);
  const [checkingStudentName, setCheckingStudentName] = useState(false);
  const [studentError, setStudentError] = useState("");
  const [studentLoading, setStudentLoading] = useState(false);
  // Tracks the student ID created in submitStudent so the picker step
  // (now AFTER the student form) can attach the daily-quiz to the
  // newly-created child.
  const [createdStudentId, setCreatedStudentId] = useState<string | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
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

  // First-mount slide-in. Run inside useEffect so the rAF call
  // doesn't fire during SSR — `requestAnimationFrame` is a
  // browser-only API and crashed the server render with
  // "ReferenceError: requestAnimationFrame is not defined" when
  // it ran from the component body.
  useEffect(() => {
    if (phase === "in" && step === 0) {
      requestAnimationFrame(() => requestAnimationFrame(() => setPhase("idle")));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish(allAnswers: Answers) {
    // questionDifficulty defaults to "standard" (top-school
    // difficulty). We used to ask, but the Q1 friction wasn't worth
    // the signal — parents can flip the toggle later on the student
    // account if they want the adaptive start-easy variant.
    const questionDifficulty = allAnswers.questionDifficulty ?? "standard";
    // Persist parent preferences. Best-effort — failures here shouldn't
    // block the flow.
    try {
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: parentId,
          settings: {
            questionDifficulty,
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
            settings: { questionDifficulty },
          }),
        });
      }
    } catch {
      // Non-fatal — answers are best-effort.
    }
    // If the parent already has a linked student (re-entering
    // onboarding), skip the student-creation step and go straight to
    // the picker. Otherwise create the student first.
    if (studentId) {
      setShowQuizPicker(true);
    } else {
      setStudentStep(true);
    }
  }

  // Shared quiz-create body — used by both "Start Quiz" (parent hands
  // the tab straight to the child) and "Assign and Email Link"
  // (parent stays; child gets an emailed access link).
  function buildQuizBody(sid: string) {
    const quizBody: Record<string, unknown> = {
      userId: parentId,
      studentId: sid,
      quizType: pickerType,
      subject: pickerSubject!,
      firstQuiz: true,  // cap MCQ count at 15 (instead of 20) for the onboarding quiz
    };
    if (pickerSubject === "english") {
      const sections = ["grammar-mcq", "vocab-mcq"];
      if (pickerType === "mcq-oeq") sections.push("editing", "comprehension-cloze");
      quizBody.englishSections = sections;
    }
    return quizBody;
  }

  // Start Quiz — create the diagnostic and navigate this tab straight
  // into it as the child. Mirrors the signup Step-3 pattern so the
  // kid starts within one tap.
  async function startQuizFromPicker() {
    if (!pickerSubject) return;
    const sid = createdStudentId ?? studentId;
    if (!sid) {
      console.error("[onboarding] no studentId — cannot create quiz");
      return;
    }
    setPickerLoading(true);
    try {
      const res = await fetch("/api/daily-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildQuizBody(sid)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to create quiz");
        setPickerLoading(false);
        return;
      }
      const quiz = await res.json();
      router.replace(`/quiz/${quiz.id}?userId=${sid}&diagnostic=1&parentId=${parentId}`);
    } catch (err) {
      console.warn("Diagnostic quiz creation failed:", err);
      setPickerLoading(false);
    }
  }

  // Assign and Email Link — create the quiz, fire an email-notify
  // request (endpoint TODO — currently a best-effort call to the
  // welcome-mail helper), and route the parent back to their home so
  // they can see the assigned paper. Kid opens the emailed link when
  // they're available.
  async function assignAndEmailLink() {
    if (!pickerSubject) return;
    const sid = createdStudentId ?? studentId;
    if (!sid) {
      console.error("[onboarding] no studentId — cannot create quiz");
      return;
    }
    setPickerLoading(true);
    try {
      await fetch("/api/daily-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildQuizBody(sid)),
      });
      // Best-effort email notify to the parent. Fire-and-forget —
      // the confirmation popup fires whether or not this call succeeds
      // so a transient SendGrid hiccup doesn't stall the UX.
      fetch("/api/notify-quiz-assigned", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId, studentId: sid, subject: pickerSubject }),
      }).catch(() => { /* non-fatal */ });
    } catch (err) {
      console.warn("Diagnostic quiz creation failed:", err);
    }
    setPickerLoading(false);
    setAssignedConfirmationSid(sid);
  }

  function goToHomeFromPicker() {
    // Legacy no-op path kept in case any deep link still points at
    // it — routes home the same way assignAndEmailLink does.
    const sid = createdStudentId ?? studentId;
    if (sid) {
      router.replace(`/home/${parentId}?firstAssignStudent=${sid}`);
    } else {
      router.replace(`/home/${parentId}`);
    }
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
      // "hard" → "standard" (full top-school range). Default to
      // "standard" (top-school difficulty) now that Q1 is retired.
      const rawDifficulty = answers.questionDifficulty ?? "standard";
      const studentDifficulty = rawDifficulty === "hard" ? "standard" : rawDifficulty;
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: student.id, settings: { questionDifficulty: studentDifficulty } }),
      }).catch(() => { /* non-fatal */ });
      // Save the new student ID and transition to the quiz picker.
      // Quiz creation now happens in startQuizFromPicker so the parent
      // can opt out via "Go to parent homepage".
      setCreatedStudentId(student.id);
      setStudentStep(false);
      setShowQuizPicker(true);
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
          {!done && (step > 0 || studentStep) && (
            <button
              onClick={() => {
                // Back from student form → last question (level).
                // Back from any question → previous question.
                // Back is hidden on the quiz picker — by then the
                // student account is committed, so the only options
                // are Start Quiz or Go to homepage.
                if (studentStep) {
                  setStudentStep(false);
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
        {/* Progress bar — 2 questions + student creation + quiz picker.
            The student form and picker each occupy their own tick so
            the parent can see how much is left. */}
        <div className="flex gap-1.5">
          {Array.from({ length: TOTAL_STEPS + 2 }).map((_, i) => {
            const currentIdx = showQuizPicker ? TOTAL_STEPS + 1
              : studentStep ? TOTAL_STEPS
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
            : showQuizPicker ? `Step ${TOTAL_STEPS + 2} of ${TOTAL_STEPS + 2}`
            : studentStep ? `Step ${TOTAL_STEPS + 1} of ${TOTAL_STEPS + 2}`
            : `Step ${step + 1} of ${TOTAL_STEPS + 2}`}
        </p>
      </header>

      <main className="flex-1 px-6 max-w-md mx-auto w-full overflow-hidden flex flex-col justify-center pb-12 relative z-10">
        {studentStep ? (
          <div style={{ animation: "popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
            <p className="text-sm font-bold text-[#003366] mb-3 uppercase tracking-wider">Almost done</p>
            <h2 className="font-headline font-extrabold text-2xl text-[#001e40] leading-snug mb-3">Set up your child&apos;s login</h2>
            <p className="text-sm text-[#43474f] leading-relaxed mb-3">
              Pick a username and password your child will use to log in to MarkForYou.
            </p>
            <div className="mb-6 px-4 py-3 rounded-2xl bg-[#fff8e1] border-2 border-[#ffb952]/40">
              <p className="text-sm text-[#001e40] leading-relaxed">
                <span className="font-extrabold">Your child gets their own account, separate from yours.</span> They&apos;ll log in with the username and password you set below — please don&apos;t share your parent login with them as you will have additional functions.
              </p>
            </div>
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
        ) : showQuizPicker ? (
          <div style={{ animation: "popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
            <p className="text-sm font-bold text-[#003366] mb-3 uppercase tracking-wider">Great!</p>
            <h2 className="font-headline font-extrabold text-2xl text-[#001e40] leading-snug mb-3">Let&apos;s get started.</h2>
            <p className="text-sm text-[#43474f] leading-relaxed mb-5">
              Let&apos;s start with a quick (~20 mins) diagnosis of your child. Pick a subject, and whether you would like <strong>MCQ only</strong> or <strong>MCQ + OEQ</strong> (stylus recommended).
            </p>
            <div className="space-y-4 mb-5">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mb-2">Subject</p>
                <div className="flex flex-wrap gap-2">
                  {(["math", "science", "english"] as const).map(subj => {
                    const isSelected = pickerSubject === subj;
                    return (
                      <button
                        key={subj}
                        type="button"
                        onClick={() => setPickerSubject(subj)}
                        className="px-4 py-2.5 rounded-full text-sm font-semibold transition-colors flex items-center gap-1.5"
                        style={{
                          background: isSelected ? "#003366" : "#ffffff",
                          color: isSelected ? "#ffffff" : "#003366",
                          border: isSelected ? "2px solid #003366" : "2px solid #dce9ff",
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
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mb-2">Question type</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPickerType("mcq")}
                    className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                    style={{
                      background: pickerType === "mcq" ? "#003366" : "#ffffff",
                      color: pickerType === "mcq" ? "#ffffff" : "#003366",
                      border: pickerType === "mcq" ? "2px solid #003366" : "2px solid #dce9ff",
                    }}
                  >
                    MCQ Only
                  </button>
                  <button
                    type="button"
                    onClick={() => setPickerType("mcq-oeq")}
                    className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                    style={{
                      background: pickerType === "mcq-oeq" ? "#003366" : "#ffffff",
                      color: pickerType === "mcq-oeq" ? "#ffffff" : "#003366",
                      border: pickerType === "mcq-oeq" ? "2px solid #003366" : "2px solid #dce9ff",
                    }}
                  >
                    MCQ + OEQ
                  </button>
                </div>
                {pickerType === "mcq-oeq" && (
                  <p className="text-[11px] text-[#43474f] mt-1.5 ml-1">Stylus recommended</p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={startQuizFromPicker}
              disabled={!pickerSubject || pickerLoading}
              className="w-full py-4 px-6 rounded-2xl font-bold text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-50"
              style={{ background: "linear-gradient(to bottom right, #001e40, #003366)" }}
            >
              {pickerLoading ? "Starting quiz…" : "Start Quiz"}
            </button>
            <p className="text-xs text-[#43474f] mt-2.5 text-center leading-relaxed px-2">
              💡 If your child is not available, we can still assign the quiz — we&apos;ll email you a link for your child to access when ready.
            </p>
            <button
              type="button"
              onClick={assignAndEmailLink}
              disabled={!pickerSubject || pickerLoading}
              className="w-full mt-3 py-3.5 px-6 rounded-2xl font-bold text-[#001e40] bg-white border-2 border-[#dce9ff] hover:bg-[#f5f9ff] transition-all disabled:opacity-50"
            >
              Assign and Email Link
            </button>
            {/* Final reminder — short by design; the longer explanation
                lives on the student-creation step. */}
            <div className="mt-6 px-4 py-3 rounded-2xl bg-[#eff4ff] border-2 border-[#dce9ff]">
              <p className="text-xs text-[#001e40] leading-relaxed">
                <span className="font-extrabold">Reminder:</span> your child has his/her own login that you have set. We will email the homepage-access link to your email as well.
              </p>
            </div>
          </div>
        ) : done ? (
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

      {/* Assign-and-email confirmation popup. Fires from
          assignAndEmailLink after the /api/daily-quiz + notify calls
          complete. Two-choice: parent goes home to explore, or stays
          on this screen (rare — e.g. wanted to assign a second one). */}
      {assignedConfirmationSid && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ background: "rgba(11,28,48,0.4)", backdropFilter: "blur(4px)" }}
        >
          <div className="w-full max-w-md rounded-3xl overflow-hidden bg-white shadow-2xl" style={{ animation: "popIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
            <div className="px-7 pt-8 pb-3 flex flex-col items-center text-center">
              <div className="relative w-16 h-16 mb-4">
                <div className="absolute inset-0 rounded-full" style={{ background: "rgba(108,248,187,0.4)", animation: "pulseRing 1.4s ease-out infinite" }} />
                <div className="relative w-16 h-16 rounded-full bg-[#6cf8bb] flex items-center justify-center text-[#006c49] shadow-lg">
                  <span className="material-symbols-outlined" style={{ fontSize: 34, fontVariationSettings: "'FILL' 1, 'wght' 700" }}>check</span>
                </div>
              </div>
              <h3 className="font-headline text-xl font-extrabold text-[#0b1c30] mb-2">Quiz assigned!</h3>
              <p className="text-sm text-[#43474f] leading-relaxed">
                We&rsquo;ve created the {pickerSubject} diagnostic and emailed the sign-in link to your inbox. Your child can open it whenever they&rsquo;re ready.
              </p>
            </div>
            <div className="px-6 pt-4 pb-6 space-y-3">
              <p className="text-sm text-[#001e40] text-center leading-relaxed">
                Want to explore the parent homepage while you wait?
              </p>
              <button
                onClick={() => {
                  const sid = assignedConfirmationSid;
                  setAssignedConfirmationSid(null);
                  router.replace(`/home/${parentId}?firstAssignStudent=${sid}`);
                }}
                className="w-full py-3.5 rounded-2xl font-bold text-white shadow-md hover:shadow-lg transition-all"
                style={{ background: "linear-gradient(to bottom right, #001e40, #003366)" }}
              >
                Go to parent homepage
              </button>
              <button
                onClick={() => setAssignedConfirmationSid(null)}
                className="w-full py-3 rounded-2xl font-bold text-[#43474f] bg-white hover:bg-slate-50 border border-slate-200 transition-colors"
              >
                Stay here
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
