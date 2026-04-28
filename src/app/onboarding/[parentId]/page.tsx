"use client";

import { use, useEffect, useState } from "react";
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
    preamble: "Hi there! 👋 We'll ask a few quick questions so we can tailor MarkForYou to your child's learning needs.",
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
    prompt: "What is the typical duration your child can focus on a homework before needing a break?",
    options: [
      { value: "short", label: "5–15 minutes" },
      { value: "long", label: "20–40 minutes" },
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
    // Pass the choice through to the home dashboard so it can surface
    // the right follow-up (instructions / quiz / print).
    router.replace(`/home/${parentId}?diagnostic=${kind}`);
  }

  const q = QUESTIONS[step];
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
          {!done && step > 0 && (
            <button
              onClick={() => {
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
        {/* Progress bar */}
        <div className="flex gap-1.5">
          {QUESTIONS.map((_, i) => (
            <div
              key={i}
              className={`flex-1 h-1.5 rounded-full transition-all duration-500 ${
                i < step || done ? "bg-[#003366]" : i === step ? "bg-[#003366]/40" : "bg-slate-200"
              }`}
            />
          ))}
        </div>
        <p className="text-xs text-[#43474f] mt-2 font-medium tracking-wide">{done ? "All done" : `Step ${step + 1} of ${TOTAL_STEPS}`}</p>
      </header>

      <main className="flex-1 px-6 max-w-md mx-auto w-full overflow-hidden flex flex-col justify-center pb-12 relative z-10">
        {showDiagnosisChoice ? (() => {
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
              sub: "Send any past paper (graded or ungraded) to diagnose@inbound.markforyou.com. Our AI auto-marks and finds the gaps.",
            },
          ];
          const optionsPaper = [
            {
              key: "scan-email" as const,
              icon: "mail",
              title: "Scan and email a recent test",
              sub: "Send any past paper (graded or ungraded) to diagnose@inbound.markforyou.com. Our AI auto-marks and finds the gaps.",
            },
            {
              key: "platform-quiz" as const,
              icon: "devices",
              title: "15-min quiz on the platform",
              sub: "Quick on-screen diagnostic. Results show up immediately.",
            },
            {
              key: "printable" as const,
              icon: "print",
              title: "Print out a 15-min quiz",
              sub: "Download a PDF, your child writes on paper, scan it back when done.",
            },
          ];
          const opts = screenHeavy ? optionsLight : optionsPaper;
          const blurb = screenHeavy
            ? <>We can set a quick 15-min quiz to read where your child is in <strong>Math</strong>, <strong>Science</strong> or <strong>English</strong>. Or, if you'd rather use an existing test, scan and email one in.</>
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
              <p className="text-sm font-bold text-[#003366] mb-3 uppercase tracking-wider">{q.preamble}</p>
            )}
            <h2 className="font-headline font-extrabold text-2xl text-[#001e40] leading-snug mb-7">{q.prompt}</h2>
            <div className="flex flex-col gap-3">
              {q.options.map((opt, i) => (
                <button
                  key={String(opt.value)}
                  onClick={() => pickAnswer(opt.value)}
                  className="group text-left bg-white border-2 border-[#dce9ff] rounded-2xl p-4 hover:border-[#003366] hover:bg-[#f5f9ff] hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] transition-all"
                  style={{ animation: `slideUp 0.4s ease-out ${0.06 + i * 0.06}s both` }}
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
      `}</style>
    </div>
  );
}
