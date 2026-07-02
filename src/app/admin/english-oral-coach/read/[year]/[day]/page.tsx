"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { ExaminerAvatar } from "@/components/ExaminerAvatar";

// Reading Aloud module — student reads the year's Day-N reading passage
// aloud, Azure Speech SDK returns per-word pronunciation scores, we
// render coloured word highlights + overall score card.
//
// SDK is imported dynamically because it references `window` at module
// scope and will crash Next's server render otherwise.

export default function ReadAloudPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

type PassageDay = {
  day: number;
  readingPassage: string;
  stimulusDescription: string;
  conversationPrompts: string[];
};

type WordScore = {
  word: string;
  accuracyScore: number;
  errorType: string;   // "None" | "Mispronunciation" | "Omission" | "Insertion" | ...
  breakErrors: string[];      // e.g. ["MissingBreak"] or ["UnexpectedBreak"]
  intonationErrors: string[]; // e.g. ["Monotone"]
};

type ScoreSummary = {
  overall: number;
  accuracy: number;
  fluency: number;
  completeness: number;
  prosody: number | null;
  words: WordScore[];
  transcription: string;
  seab: {
    total: number;          // /20 — Reading Aloud
    pronunciation: number;  // /8  — articulation & pronunciation
    fluencyRhythm: number;  // /6  — pace, chunking, natural pauses
    expressiveness: number; // /6  — pitch variation, stress, rhythm
  };
};

function Inner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const year = String(params.year);
  const dayNum = Number(params.day);
  const userId = searchParams.get("userId") ?? "";

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [passage, setPassage] = useState<PassageDay | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "recording" | "scoring" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState<ScoreSummary | null>(null);
  const recognizerRef = useRef<unknown>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  useEffect(() => {
    if (!allowed) return;
    fetch(`/api/admin/english-oral-coach/corpus?userId=${userId}`)
      .then(async r => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then((json: { rows: Array<{ year: string; oralDays?: unknown }> }) => {
        // corpus route returns preview strings; we need the full structured
        // oralDays for the read passage. Reload from the /api directly.
      })
      .catch(() => {});
    fetch(`/api/admin/english-oral-coach/read?userId=${userId}&year=${year}&day=${dayNum}`)
      .then(async r => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then((json: { day: PassageDay | null }) => {
        if (!json.day) throw new Error("No passage found for this year/day.");
        setPassage(json.day);
        setStatus("ready");
      })
      .catch((e: Error) => { setError(e.message); setStatus("error"); });
  }, [allowed, userId, year, dayNum]);

  async function startReading() {
    if (!passage) return;
    setError(null);
    setScore(null);
    setStatus("recording");
    try {
      const sdk = await import("microsoft-cognitiveservices-speech-sdk");
      const tokenResp = await fetch("/api/oral-coach/azure-token", { method: "POST" });
      if (!tokenResp.ok) throw new Error(`Token fetch failed: ${await tokenResp.text()}`);
      const { token, region } = await tokenResp.json();

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token, region);
      speechConfig.speechRecognitionLanguage = "en-GB";
      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      const paConfig = new sdk.PronunciationAssessmentConfig(
        passage.readingPassage,
        sdk.PronunciationAssessmentGradingSystem.HundredMark,
        sdk.PronunciationAssessmentGranularity.Phoneme,
        /* enableMiscue */ true,
      );
      paConfig.enableProsodyAssessment = true;
      paConfig.applyTo(recognizer);
      recognizerRef.current = recognizer;

      recognizer.recognizeOnceAsync(
        (result) => {
          try {
            if (result.reason !== sdk.ResultReason.RecognizedSpeech) {
              throw new Error(`Recognition returned reason ${result.reason} — try again.`);
            }
            const pa = sdk.PronunciationAssessmentResult.fromResult(result);
            const detail: unknown = JSON.parse(
              result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult) ?? "{}",
            );
            const words = extractWords(detail);
            const prosody = (pa as { prosodyScore?: number }).prosodyScore ?? null;
            setScore({
              overall: pa.pronunciationScore,
              accuracy: pa.accuracyScore,
              fluency: pa.fluencyScore,
              completeness: pa.completenessScore,
              prosody,
              words,
              transcription: result.text,
              seab: computeSeabScore(pa.accuracyScore, pa.fluencyScore, prosody),
            });
            setStatus("done");
          } catch (e) {
            setError((e as Error).message);
            setStatus("error");
          } finally {
            recognizer.close();
          }
        },
        (err) => {
          setError(String(err));
          setStatus("error");
          recognizer.close();
        },
      );
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }

  function stopReading() {
    const r = recognizerRef.current as { stopContinuousRecognitionAsync?: () => void } | null;
    if (r?.stopContinuousRecognitionAsync) r.stopContinuousRecognitionAsync();
    setStatus("scoring");
  }

  if (allowed === null) return <FullPageSpinner />;
  if (!allowed) return <FullPageDenied />;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <Link href={`/admin/english-oral-coach?userId=${userId}`} className="text-slate-400 hover:text-slate-600 text-xs">← Oral Coach</Link>
          <h1 className="text-lg font-bold text-slate-800">Reading Aloud — {year} · Day {dayNum}</h1>
        </div>

        <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
          {status === "loading" && <Card>Loading passage…</Card>}
          {status === "error" && <Card><p className="text-rose-600 text-sm">{error}</p></Card>}

          {passage && (
            <>
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-4">
                {/* Read Aloud has no "examiner speaking" mode — the
                    student does all the talking. Still loops throughout. */}
                <ExaminerAvatar
                  speaking={false}
                  className="w-24 h-24 rounded-full bg-slate-100 flex-shrink-0"
                />
                <div className="flex-1">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Examiner</p>
                  <p className="text-sm text-slate-700">Read the passage aloud when you're ready. Speak at a natural pace — I'll score your pronunciation, fluency and expressiveness.</p>
                </div>
                {status === "ready" && (
                  <button onClick={startReading} className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-700">Start Reading</button>
                )}
                {status === "recording" && (
                  <button onClick={stopReading} className="bg-rose-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold animate-pulse">● Recording — Stop</button>
                )}
                {status === "scoring" && <span className="text-sm text-slate-500">Scoring…</span>}
                {status === "done" && (
                  <button onClick={() => { setScore(null); setStatus("ready"); }} className="bg-slate-800 text-white px-5 py-2.5 rounded-xl text-sm font-semibold">Try again</button>
                )}
              </div>

              {/* Passage — coloured after scoring */}
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Reading Passage</p>
                {score ? (
                  <ColouredPassage passage={passage.readingPassage} words={score.words} />
                ) : (
                  <p className="text-slate-800 text-4xl leading-relaxed whitespace-pre-wrap">{passage.readingPassage}</p>
                )}
              </div>

              {/* Score card — SEAB rubric on top, Azure raw as backup */}
              {score && (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-5">
                  <div className="rounded-2xl bg-gradient-to-br from-indigo-50 to-indigo-100 border border-indigo-200 p-5">
                    <p className="text-[10px] uppercase tracking-wide text-indigo-500 font-semibold">SEAB Reading Aloud (predicted)</p>
                    <div className="flex items-end gap-2 mt-1">
                      <span className="text-5xl font-bold text-indigo-700">{score.seab.total}</span>
                      <span className="text-lg text-indigo-500 pb-1">/ 20</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 mt-4">
                      <SeabDim label="Pronunciation" value={score.seab.pronunciation} outOf={8} desc="articulation, sounds" />
                      <SeabDim label="Fluency & rhythm" value={score.seab.fluencyRhythm} outOf={6} desc="pace, chunking" />
                      <SeabDim label="Expressiveness" value={score.seab.expressiveness} outOf={6} desc="pitch, stress" />
                    </div>
                  </div>

                  {/* Azure raw — collapsed by default to keep the SEAB focus */}
                  <details>
                    <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600">Underlying Azure Speech scores (0-100)</summary>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3">
                      <Metric label="Overall" value={score.overall} />
                      <Metric label="Accuracy" value={score.accuracy} />
                      <Metric label="Fluency" value={score.fluency} />
                      <Metric label="Completeness" value={score.completeness} />
                      {score.prosody !== null && <Metric label="Prosody" value={score.prosody} />}
                    </div>
                    <p className="text-xs text-slate-400 mt-3 leading-relaxed">
                      SEAB Pronunciation ≈ Azure Accuracy · 0.08 · &nbsp;
                      SEAB Fluency ≈ Azure Fluency · 0.06 · &nbsp;
                      SEAB Expressiveness ≈ Azure Prosody · 0.06 (falls back to Fluency when prosody isn&apos;t returned).
                    </p>
                  </details>

                  {/* Specific tips — actionable per-word feedback */}
                  <TipsBlock words={score.words} />

                  <details>
                    <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600">Show recognised transcription</summary>
                    <p className="mt-2 text-xs text-slate-500 italic">{score.transcription}</p>
                  </details>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// -- helpers --------------------------------------------------------------

function extractWords(detail: unknown): WordScore[] {
  // Azure's raw JSON: NBest[0].Words[].{ Word, PronunciationAssessment: { AccuracyScore, ErrorType, Feedback: { Prosody: { Break: { ErrorTypes }, Intonation: { ErrorTypes } } } } }
  type RawWord = {
    Word: string;
    PronunciationAssessment?: {
      AccuracyScore?: number;
      ErrorType?: string;
      Feedback?: {
        Prosody?: {
          Break?: { ErrorTypes?: string[] };
          Intonation?: { ErrorTypes?: string[] };
        };
      };
    };
  };
  const d = detail as { NBest?: Array<{ Words?: RawWord[] }> };
  const rawWords = d.NBest?.[0]?.Words ?? [];
  return rawWords.map((w) => ({
    word: w.Word,
    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? 0,
    errorType: w.PronunciationAssessment?.ErrorType ?? "None",
    breakErrors: w.PronunciationAssessment?.Feedback?.Prosody?.Break?.ErrorTypes ?? [],
    intonationErrors: w.PronunciationAssessment?.Feedback?.Prosody?.Intonation?.ErrorTypes ?? [],
  }));
}

// SEAB Reading Aloud is scored /20 across three dimensions. Rough
// conversion from Azure's 0-100 scales, weighted per the SEAB rubric:
//   Pronunciation / articulation: 8 marks  ← AccuracyScore
//   Fluency & rhythm:             6 marks  ← FluencyScore
//   Expressiveness:               6 marks  ← ProsodyScore
// If prosody isn't returned (older SDK / feature disabled), the
// expressiveness dimension falls back to a fluency-proxied estimate
// so the /20 total is still meaningful.
function computeSeabScore(
  accuracy: number,
  fluency: number,
  prosody: number | null,
): ScoreSummary["seab"] {
  const pronunciation = (accuracy / 100) * 8;
  const fluencyRhythm = (fluency / 100) * 6;
  const expressiveness = ((prosody ?? fluency) / 100) * 6;
  return {
    pronunciation: round1(pronunciation),
    fluencyRhythm: round1(fluencyRhythm),
    expressiveness: round1(expressiveness),
    total: round1(pronunciation + fluencyRhythm + expressiveness),
  };
}
function round1(n: number): number { return Math.round(n * 10) / 10; }

// Collapse per-word prosody + accuracy issues into a small number of
// actionable tips. Each tip names 2-3 example words so the student
// knows where to try again without reading a wall of feedback.
type TipGroup = { label: string; hint: string; examples: string[]; count: number; tone: "amber" | "rose" };
function buildTips(words: WordScore[]): TipGroup[] {
  const monotone = words.filter((w) => w.intonationErrors.includes("Monotone"));
  const missingBreak = words.filter((w) => w.breakErrors.includes("MissingBreak"));
  const unexpectedBreak = words.filter((w) => w.breakErrors.includes("UnexpectedBreak"));
  const mispronounced = words.filter((w) => w.errorType === "Mispronunciation" || (w.errorType === "None" && w.accuracyScore < 60));
  const wobble = words.filter((w) => w.errorType === "None" && w.accuracyScore >= 60 && w.accuracyScore < 85);
  const omissions = words.filter((w) => w.errorType === "Omission");

  const groups: TipGroup[] = [];
  if (mispronounced.length > 0) {
    groups.push({
      label: "Mispronounced words",
      hint: "Say each syllable slowly, then blend. Record yourself and compare with a dictionary audio.",
      examples: mispronounced.slice(0, 6).map((w) => w.word),
      count: mispronounced.length,
      tone: "rose",
    });
  }
  if (wobble.length > 0) {
    groups.push({
      label: "Slight wobbles — worth another pass",
      hint: "Not wrong, just not quite crisp. Slow down on these and land the vowel cleanly.",
      examples: wobble.slice(0, 6).map((w) => w.word),
      count: wobble.length,
      tone: "amber",
    });
  }
  if (omissions.length > 0) {
    groups.push({
      label: "Skipped words",
      hint: "You missed these entirely. Read at a pace where you can look ahead one word — that stops the eye rushing past.",
      examples: omissions.slice(0, 6).map((w) => w.word),
      count: omissions.length,
      tone: "rose",
    });
  }
  if (monotone.length > 0) {
    groups.push({
      label: "Monotone stretches — add pitch",
      hint: "Your voice stayed flat here. Try lifting on content words (nouns, verbs, adjectives) and dropping on the little ones (a, the, of).",
      examples: monotone.slice(0, 6).map((w) => w.word),
      count: monotone.length,
      tone: "amber",
    });
  }
  if (missingBreak.length > 0) {
    groups.push({
      label: "Missing pauses",
      hint: "A small pause here helps meaning land. Aim for a soft breath after commas and clause boundaries.",
      examples: missingBreak.slice(0, 6).map((w) => w.word),
      count: missingBreak.length,
      tone: "amber",
    });
  }
  if (unexpectedBreak.length > 0) {
    groups.push({
      label: "Unexpected pauses",
      hint: "You paused mid-phrase — the meaning breaks. Read a whole clause in one breath and pause only at commas / full stops.",
      examples: unexpectedBreak.slice(0, 6).map((w) => w.word),
      count: unexpectedBreak.length,
      tone: "amber",
    });
  }
  return groups;
}

function styleFor(score: number, error: string): { className: string; showScore: boolean } {
  // Strong reads stay in plain black type so the visual noise stays
  // low — only actual problems get colour treatment. Kids reading the
  // scored passage back should see at a glance which few words need
  // work, not a rainbow.
  if (error === "Omission")   return { className: "text-slate-400 line-through", showScore: false };
  if (error === "Insertion")  return { className: "text-amber-600 underline decoration-dotted", showScore: false };
  if (score >= 85)            return { className: "text-slate-800", showScore: false };
  if (score >= 60)            return { className: "text-amber-600 font-semibold", showScore: true };
  return { className: "text-rose-600 font-semibold", showScore: true };
}

function ColouredPassage({ passage, words }: { passage: string; words: WordScore[] }) {
  // Naive word alignment — Azure returns words in read order and skips
  // punctuation. Only problem words get colour + a score badge; good
  // words render as plain black type identical to the pre-scoring view.
  return (
    <p className="text-slate-800 text-4xl leading-loose">
      {words.map((w, i) => {
        const s = styleFor(w.accuracyScore, w.errorType);
        return (
          <span key={i} className={`inline-block mr-[6px] ${s.className}`}>
            {w.word}
            {s.showScore && (
              <span className="text-xs align-super ml-0.5 opacity-70">{Math.round(w.accuracyScore)}</span>
            )}
          </span>
        );
      })}
      <span className="block text-xs text-slate-400 mt-4 not-italic">
        Legend:
        <span className="inline-block ml-2 text-amber-600 font-semibold">amber = wobble</span>
        <span className="inline-block ml-3 text-rose-600 font-semibold">red = mispronounced</span>
        <span className="inline-block ml-3 text-slate-400 line-through">skipped</span>
        <span className="inline-block ml-3 text-amber-600 underline decoration-dotted">extra word</span>
      </span>
    </p>
  );
}

function Metric({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  const rounded = Math.round(value);
  const colour = rounded >= 85 ? "text-emerald-600" : rounded >= 60 ? "text-amber-600" : "text-rose-600";
  return (
    <div className={`rounded-xl border p-3 ${highlight ? "border-indigo-200 bg-indigo-50" : "border-slate-100"}`}>
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-2xl font-bold ${colour}`}>{rounded}<span className="text-sm text-slate-400 ml-1">/100</span></p>
    </div>
  );
}

function SeabDim({ label, value, outOf, desc }: { label: string; value: number; outOf: number; desc: string }) {
  const pct = outOf > 0 ? value / outOf : 0;
  const colour = pct >= 0.85 ? "text-emerald-600" : pct >= 0.65 ? "text-amber-600" : "text-rose-600";
  return (
    <div className="rounded-xl bg-white border border-indigo-100 p-3">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-xl font-bold ${colour}`}>{value.toFixed(1)}<span className="text-xs text-slate-400 ml-1">/ {outOf}</span></p>
      <p className="text-[10px] text-slate-400 mt-0.5">{desc}</p>
    </div>
  );
}

function TipsBlock({ words }: { words: WordScore[] }) {
  const tips = buildTips(words);
  if (tips.length === 0) {
    return (
      <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4">
        <p className="text-sm text-emerald-700 font-semibold">Clean read — no specific tips to give.</p>
        <p className="text-xs text-emerald-600 mt-1">Try a harder passage or record from further away to challenge yourself.</p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Specific tips</p>
      <div className="space-y-2">
        {tips.map((t, i) => (
          <div key={i} className={`rounded-xl border p-3 ${t.tone === "rose" ? "bg-rose-50 border-rose-200" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-baseline gap-2 mb-1">
              <p className={`text-sm font-semibold ${t.tone === "rose" ? "text-rose-700" : "text-amber-700"}`}>{t.label}</p>
              <span className="text-xs text-slate-500">({t.count} {t.count === 1 ? "word" : "words"})</span>
            </div>
            <p className="text-xs text-slate-700 leading-relaxed mb-2">{t.hint}</p>
            <div className="flex flex-wrap gap-1.5">
              {t.examples.map((w, j) => (
                <span key={j} className={`text-xs px-2 py-0.5 rounded-lg ${t.tone === "rose" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>{w}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FullPageSpinner() {
  return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
}
function FullPageDenied() {
  return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">{children}</div>;
}
