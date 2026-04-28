"use client";

import { use, useState } from "react";
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
    setDone(true);
    try {
      // Save parent-level settings (study mode, focus duration, default
      // difficulty, default child level for any future student creation).
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
      // If a student account already exists (signup created one
      // before bouncing here), propagate the difficulty + level too.
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
      // Non-fatal — onboarding answers are best-effort. The parent can
      // adjust everything from Student Settings later.
    }
    setTimeout(() => router.replace(`/home/${parentId}`), 1600);
  }

  const q = QUESTIONS[step];
  const cardCls =
    "transition-all duration-300 ease-out " +
    (phase === "in" ? "translate-x-8 opacity-0"
      : phase === "out" ? "-translate-x-8 opacity-0"
      : "translate-x-0 opacity-100");

  return (
    <div className="min-h-screen bg-[#f8f9ff] flex flex-col">
      <header className="px-6 pt-6 pb-3 max-w-md mx-auto w-full">
        {/* Progress bar */}
        <div className="flex gap-1.5">
          {QUESTIONS.map((_, i) => (
            <div
              key={i}
              className={`flex-1 h-1.5 rounded-full transition-colors duration-300 ${
                i < step || done ? "bg-[#003366]" : i === step ? "bg-[#003366]/60" : "bg-slate-200"
              }`}
            />
          ))}
        </div>
        <p className="text-xs text-[#43474f] mt-2 font-medium">{done ? "Done" : `${step + 1} of ${TOTAL_STEPS}`}</p>
      </header>

      <main className="flex-1 px-6 max-w-md mx-auto w-full overflow-hidden flex flex-col justify-center pb-8">
        {done ? (
          <div className="text-center transition-opacity duration-500" style={{ animation: "fadeIn 0.5s ease both" }}>
            <div className="mx-auto w-16 h-16 rounded-3xl bg-[#6cf8bb] flex items-center justify-center mb-5 text-[#001e40]">
              <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
            </div>
            <h2 className="font-headline font-extrabold text-2xl text-[#001e40] mb-2">All set!</h2>
            <p className="text-[#43474f] text-sm">Taking you to your dashboard…</p>
          </div>
        ) : (
          <div className={cardCls} key={step}>
            {q.preamble && (
              <p className="text-base font-semibold text-[#003366] mb-2">{q.preamble}</p>
            )}
            <h2 className="font-headline font-extrabold text-xl text-[#001e40] leading-snug mb-6">{q.prompt}</h2>
            <div className="flex flex-col gap-3">
              {q.options.map(opt => (
                <button
                  key={String(opt.value)}
                  onClick={() => pickAnswer(opt.value)}
                  className="text-left bg-white border-2 border-[#dce9ff] rounded-2xl p-4 hover:border-[#003366] hover:bg-[#eff4ff] active:scale-[0.98] transition-all"
                >
                  <p className="font-bold text-[#001e40] text-sm">{opt.label}</p>
                  {opt.sub && <p className="text-xs text-[#43474f] mt-1 leading-relaxed">{opt.sub}</p>}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
