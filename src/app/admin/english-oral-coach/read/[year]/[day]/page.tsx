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
};

type ScoreSummary = {
  overall: number;
  accuracy: number;
  fluency: number;
  completeness: number;
  prosody: number | null;
  words: WordScore[];
  transcription: string;
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
            setScore({
              overall: pa.pronunciationScore,
              accuracy: pa.accuracyScore,
              fluency: pa.fluencyScore,
              completeness: pa.completenessScore,
              prosody: (pa as { prosodyScore?: number }).prosodyScore ?? null,
              words,
              transcription: result.text,
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
                  <p className="text-slate-800 text-lg leading-relaxed whitespace-pre-wrap">{passage.readingPassage}</p>
                )}
              </div>

              {/* Score card */}
              {score && (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                    <Metric label="Overall" value={score.overall} highlight />
                    <Metric label="Accuracy" value={score.accuracy} />
                    <Metric label="Fluency" value={score.fluency} />
                    <Metric label="Completeness" value={score.completeness} />
                    {score.prosody !== null && <Metric label="Prosody" value={score.prosody} />}
                  </div>
                  <SlipCard words={score.words} />
                  <details className="mt-4">
                    <summary className="text-xs text-slate-400 cursor-pointer">Show recognised transcription</summary>
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
  // Azure's raw JSON: NBest[0].Words[].{ Word, PronunciationAssessment: { AccuracyScore, ErrorType } }
  const d = detail as { NBest?: Array<{ Words?: Array<{ Word: string; PronunciationAssessment?: { AccuracyScore?: number; ErrorType?: string } }> }> };
  const rawWords = d.NBest?.[0]?.Words ?? [];
  return rawWords.map(w => ({
    word: w.Word,
    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? 0,
    errorType: w.PronunciationAssessment?.ErrorType ?? "None",
  }));
}

function colourFor(score: number, error: string): string {
  if (error === "Omission") return "bg-slate-300 text-slate-500 line-through";
  if (error === "Insertion") return "bg-amber-100 text-amber-700 underline";
  if (score >= 85) return "bg-emerald-100 text-emerald-800";
  if (score >= 60) return "bg-amber-100 text-amber-800";
  return "bg-rose-100 text-rose-800";
}

function ColouredPassage({ passage, words }: { passage: string; words: WordScore[] }) {
  // Naive word alignment — Azure returns words in read order and skips
  // punctuation. We render the recognised words with their colour plus
  // preserve leading/trailing punctuation for readability.
  return (
    <p className="text-slate-800 text-lg leading-loose">
      {words.map((w, i) => (
        <span key={i} className={`inline-block px-1 mx-[1px] rounded ${colourFor(w.accuracyScore, w.errorType)}`}>
          {w.word}
          <span className="text-[10px] align-super ml-0.5 opacity-70">{Math.round(w.accuracyScore)}</span>
        </span>
      ))}
      <span className="block text-xs text-slate-400 mt-3 not-italic">
        Legend:
        <span className="inline-block ml-2 px-1 rounded bg-emerald-100 text-emerald-800">≥85 strong</span>
        <span className="inline-block ml-1 px-1 rounded bg-amber-100 text-amber-800">60–84 wobble</span>
        <span className="inline-block ml-1 px-1 rounded bg-rose-100 text-rose-800">&lt;60 mispronounced</span>
        <span className="inline-block ml-1 px-1 rounded bg-slate-300 text-slate-500 line-through">skipped</span>
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

function SlipCard({ words }: { words: WordScore[] }) {
  const worst = [...words].filter(w => w.accuracyScore < 60 || w.errorType !== "None").slice(0, 8);
  if (worst.length === 0) return <p className="text-sm text-emerald-700">No obvious slips — smooth read.</p>;
  return (
    <div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Words to work on</p>
      <div className="flex flex-wrap gap-2">
        {worst.map((w, i) => (
          <span key={i} className="px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700">
            <strong>{w.word}</strong>
            <span className="text-slate-400 ml-2 text-xs">{Math.round(w.accuracyScore)}</span>
            {w.errorType !== "None" && <span className="ml-2 text-xs text-rose-600">{w.errorType}</span>}
          </span>
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
