"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
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
  offset?: number;            // 100ns ticks — Azure raw
  duration?: number;          // 100ns ticks — how long the student spent on this word
};

type Breakdown = {
  pronunciation: {
    total: number;          // total words in the reference passage
    clear: number;          // >=85 accuracy, no error
    notClear: number;       // 60-84
    mispronounced: number;  // <60 or ErrorType Mispronunciation
    omitted: number;        // words the student skipped
    inserted: number;       // words the student added that weren't in the passage
  };
  fluency: {
    wpm: number;            // words per minute — computed from word offsets/durations
    unexpectedPauses: number;
    missingPauses: number;
    paceVerdict: "too slow" | "on target" | "brisk" | "too fast" | "unknown";
  };
  expressiveness: {
    monotoneWords: number;
    intonationVerdict: "flat" | "some variation" | "good variation" | "unknown";
    unnaturalBreaks: number;
  };
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
  breakdown: Breakdown;
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
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const recognizerRef = useRef<unknown>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Play a specific word's audio segment. Azure gives per-word Offset
  // (start) and Duration in 100ns ticks. We play a 3-second lead-in
  // and 3-second tail so the student hears the word in context — the
  // surrounding phrase makes it much easier to hear WHAT they said
  // wrong than the isolated word does. Falls back to a rough position
  // estimate when Azure didn't return timing.
  const LEAD_SEC = 3;
  const TAIL_SEC = 3;
  const playWord = useCallback((w: WordScore) => {
    const audio = audioRef.current;
    if (!audio) return;
    let wordStart = 0;
    let wordDuration = 0.6;
    if (typeof w.offset === "number" && typeof w.duration === "number" && w.duration > 0) {
      wordStart = w.offset / 10_000_000;
      wordDuration = w.duration / 10_000_000;
    } else {
      // Fallback — if we have overall words with timing, estimate position by index.
      const words = (score?.words ?? []).filter((x) => x.errorType !== "Omission");
      const idx = words.findIndex((x) => x.word === w.word);
      const total = audio.duration || 0;
      if (idx >= 0 && words.length > 0 && total > 0) {
        wordStart = (idx / words.length) * total;
        wordDuration = total / words.length;
      }
    }
    const totalDuration = audio.duration || wordStart + wordDuration + TAIL_SEC;
    const playStart = Math.max(0, wordStart - LEAD_SEC);
    const playEnd = Math.min(totalDuration, wordStart + wordDuration + TAIL_SEC);
    const playFor = playEnd - playStart;
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
    audio.currentTime = playStart;
    void audio.play();
    stopTimeoutRef.current = setTimeout(() => {
      audio.pause();
      stopTimeoutRef.current = null;
    }, playFor * 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  // Clean up any previous recording blob URL when a new one lands or
  // when the component unmounts — otherwise we leak memory across
  // "Try again" cycles.
  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }, [recordingUrl]);

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
    setRecordingUrl(null);
    setStatus("recording");
    try {
      // Capture the mic ourselves so we can (a) hand it to Azure for
      // scoring AND (b) hand it to a MediaRecorder that saves a copy
      // of the read for playback. Same stream feeds both.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const chunks: Blob[] = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        setRecordingUrl(URL.createObjectURL(blob));
      };
      recorder.start();
      mediaRecorderRef.current = recorder;

      const sdk = await import("microsoft-cognitiveservices-speech-sdk");
      const tokenResp = await fetch("/api/oral-coach/azure-token", { method: "POST" });
      if (!tokenResp.ok) throw new Error(`Token fetch failed: ${await tokenResp.text()}`);
      const { token, region } = await tokenResp.json();

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token, region);
      speechConfig.speechRecognitionLanguage = "en-GB";
      // Continuous recognition — recognizeOnceAsync cuts off after
      // ~15s of silence (or ~60s max), which chopped kids off mid-read
      // on longer 2024/2018 passages. Continuous keeps the mic open
      // until we explicitly stop; we aggregate per-utterance results
      // on the fly and produce one combined score card when the
      // student clicks "Stop".
      speechConfig.setProperty(
        sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
        "5000", // don't fire a segmentation until 5s of silence — kids pause between paragraphs
      );

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

      // Per-utterance aggregates
      const collected: {
        words: WordScore[];
        transcription: string;
        accuracy: number[];
        fluency: number[];
        completeness: number[];
        prosody: number[];
        pronunciation: number[];
      } = { words: [], transcription: "", accuracy: [], fluency: [], completeness: [], prosody: [], pronunciation: [] };

      recognizer.recognized = (_s, e) => {
        if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
        try {
          const pa = sdk.PronunciationAssessmentResult.fromResult(e.result);
          const detail: unknown = JSON.parse(
            e.result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult) ?? "{}",
          );
          collected.words.push(...extractWords(detail));
          collected.transcription = (collected.transcription + " " + e.result.text).trim();
          if (Number.isFinite(pa.accuracyScore)) collected.accuracy.push(pa.accuracyScore);
          if (Number.isFinite(pa.fluencyScore)) collected.fluency.push(pa.fluencyScore);
          if (Number.isFinite(pa.completenessScore)) collected.completeness.push(pa.completenessScore);
          if (Number.isFinite(pa.pronunciationScore)) collected.pronunciation.push(pa.pronunciationScore);
          const prosodyScore = (pa as { prosodyScore?: number }).prosodyScore;
          if (typeof prosodyScore === "number" && Number.isFinite(prosodyScore)) collected.prosody.push(prosodyScore);
        } catch (parseErr) {
          console.warn("PA parse error", parseErr);
        }
      };

      recognizer.canceled = (_s, e) => {
        setError(`Recognition canceled: ${e.errorDetails ?? e.reason}`);
        setStatus("error");
        recognizer.close();
      };

      recognizer.sessionStopped = () => {
        const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        const acc = avg(collected.accuracy);
        const flu = avg(collected.fluency);
        const comp = avg(collected.completeness);
        const overall = avg(collected.pronunciation);
        const prosody = collected.prosody.length ? avg(collected.prosody) : null;
        setScore({
          overall,
          accuracy: acc,
          fluency: flu,
          completeness: comp,
          prosody,
          words: collected.words,
          transcription: collected.transcription,
          seab: computeSeabScore(acc, flu, prosody),
          breakdown: computeBreakdown(collected.words, flu, prosody),
        });
        setStatus("done");
        recognizer.close();
        // Finalise the MediaRecorder so the recorded blob URL is set.
        // Then release the mic — otherwise the browser shows the
        // "in-use" indicator forever.
        const mr = mediaRecorderRef.current;
        if (mr && mr.state !== "inactive") mr.stop();
        const s = micStreamRef.current;
        if (s) s.getTracks().forEach((t) => t.stop());
        mediaRecorderRef.current = null;
        micStreamRef.current = null;
      };

      recognizer.startContinuousRecognitionAsync(
        () => { /* started */ },
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
                  <ColouredPassage
                    passage={passage.readingPassage}
                    words={score.words}
                    onPlayWord={recordingUrl ? playWord : undefined}
                  />
                ) : (
                  <p className="text-slate-800 text-lg leading-relaxed whitespace-pre-wrap">{passage.readingPassage}</p>
                )}
              </div>

              {/* Score card — SEAB Scoring Matrix + Detailed Scoring + Tips */}
              {score && (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-6">
                  <div>
                    <h2 className="text-sm font-bold text-slate-800 mb-3">SEAB Reading Aloud Scoring Matrix</h2>
                    <div className="rounded-2xl bg-gradient-to-br from-slate-50 to-white border border-slate-200 p-5">
                      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Predicted total</p>
                      <div className="flex items-end gap-2 mt-1">
                        <span className="text-5xl font-bold text-slate-800">{Math.round(score.seab.total)}</span>
                        <span className="text-xs text-slate-400 pb-2">({score.seab.total.toFixed(1)})</span>
                        <span className="text-lg text-slate-500 pb-1">/ 20</span>
                      </div>
                      <div className="grid grid-cols-3 gap-3 mt-4">
                        <SeabDim label="Pronunciation" value={score.seab.pronunciation} outOf={8} desc="articulation, sounds" tone="blue" />
                        <SeabDim label="Fluency & rhythm" value={score.seab.fluencyRhythm} outOf={6} desc="pace, chunking" tone="purple" />
                        <SeabDim label="Expressiveness" value={score.seab.expressiveness} outOf={6} desc="pitch, stress" tone="brown" />
                      </div>
                    </div>
                  </div>

                  {recordingUrl && (
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Listen to your read (click a highlighted word or tip below to hear just that word)</p>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio ref={audioRef} controls src={recordingUrl} className="w-full" preload="auto" />
                    </div>
                  )}

                  <DetailedScoring score={score} />

                  <TipsBlock words={score.words} breakdown={score.breakdown} onPlayWord={recordingUrl ? playWord : undefined} />

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
  // Azure's raw JSON: NBest[0].Words[].{ Word, Offset, Duration, PronunciationAssessment: { AccuracyScore, ErrorType, Feedback: { Prosody: { Break: { ErrorTypes }, Intonation: { ErrorTypes } } } } }
  type RawWord = {
    Word: string;
    Offset?: number;
    Duration?: number;
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
    offset: w.Offset,
    duration: w.Duration,
  }));
}

// Compute the per-category breakdown Azure exposes across its various
// per-word signals. Some inputs (WPM, pace verdict) are computed from
// word timings; others (monotone/pause counts) are direct counts of the
// prosody feedback flags Azure attached to each word.
function computeBreakdown(words: WordScore[], fluencyScore: number, prosodyScore: number | null): Breakdown {
  const spoken = words.filter((w) => w.errorType !== "Omission" && w.errorType !== "Insertion");
  const clear = spoken.filter((w) => w.accuracyScore >= 85 && w.errorType === "None").length;
  const notClear = spoken.filter((w) => w.errorType === "None" && w.accuracyScore >= 60 && w.accuracyScore < 85).length;
  const mispronounced = spoken.filter((w) => w.errorType === "Mispronunciation" || (w.errorType === "None" && w.accuracyScore < 60)).length;
  const omitted = words.filter((w) => w.errorType === "Omission").length;
  const inserted = words.filter((w) => w.errorType === "Insertion").length;
  const total = spoken.length + omitted; // words in the reference passage

  // Words-per-minute — Azure timestamps are in 100ns ticks (10,000,000 ticks = 1s).
  const timed = words.filter((w) => typeof w.offset === "number" && typeof w.duration === "number" && w.errorType !== "Omission");
  let wpm = 0;
  if (timed.length > 0) {
    const first = timed[0];
    const last = timed[timed.length - 1];
    const startTicks = first.offset ?? 0;
    const endTicks = (last.offset ?? 0) + (last.duration ?? 0);
    const durationSec = (endTicks - startTicks) / 10_000_000;
    if (durationSec > 0) wpm = Math.round((timed.length / durationSec) * 60);
  }
  const paceVerdict: Breakdown["fluency"]["paceVerdict"] =
    wpm === 0 ? "unknown" :
    wpm < 100 ? "too slow" :
    wpm <= 150 ? "on target" :
    wpm <= 170 ? "brisk" : "too fast";

  const unexpectedPauses = words.filter((w) => w.breakErrors.includes("UnexpectedBreak")).length;
  const missingPauses = words.filter((w) => w.breakErrors.includes("MissingBreak")).length;
  const monotoneWords = words.filter((w) => w.intonationErrors.includes("Monotone")).length;

  const intonationVerdict: Breakdown["expressiveness"]["intonationVerdict"] =
    prosodyScore === null ? "unknown" :
    prosodyScore >= 80 ? "good variation" :
    prosodyScore >= 60 ? "some variation" : "flat";

  return {
    pronunciation: { total, clear, notClear, mispronounced, omitted, inserted },
    fluency: {
      wpm,
      unexpectedPauses,
      missingPauses,
      paceVerdict,
    },
    expressiveness: {
      monotoneWords,
      intonationVerdict,
      unnaturalBreaks: unexpectedPauses + missingPauses,
    },
  };
  // fluencyScore + prosodyScore params aren't stored here — the top-level
  // SEAB numbers already reflect them; this breakdown is the drill-in.
  void fluencyScore;
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

// Categorised tips grouped by the SEAB dimension they support.
// - Pronunciation (blue): mispronounced / not-clear / skipped words
// - Fluency & Rhythm (purple): pace + unexpected/missing pauses
// - Expressiveness (brown): monotone stretches + intonation guidance
// Each tip carries the WordScore refs (not just strings) so the tip
// chips can be clicked to play just that word from the recording.

type TipItem = { label: string; hint: string; examples: WordScore[]; count: number };
type TipCategory = { key: ToneKey; title: string; tone: ToneKey; items: TipItem[] };

function buildTips(words: WordScore[], breakdown: Breakdown): TipCategory[] {
  const mispronounced = words.filter((w) => w.errorType === "Mispronunciation" || (w.errorType === "None" && w.accuracyScore < 60));
  const notClear = words.filter((w) => w.errorType === "None" && w.accuracyScore >= 60 && w.accuracyScore < 85);
  const omissions = words.filter((w) => w.errorType === "Omission");
  const monotone = words.filter((w) => w.intonationErrors.includes("Monotone"));
  const missingBreak = words.filter((w) => w.breakErrors.includes("MissingBreak"));
  const unexpectedBreak = words.filter((w) => w.breakErrors.includes("UnexpectedBreak"));

  const pronunciationItems: TipItem[] = [];
  if (mispronounced.length > 0) {
    pronunciationItems.push({
      label: "Mispronounced words",
      hint: "Say each syllable slowly, then blend. Record yourself and compare with a dictionary audio. Click a word to hear yourself say it.",
      examples: mispronounced.slice(0, 8),
      count: mispronounced.length,
    });
  }
  if (notClear.length > 0) {
    pronunciationItems.push({
      label: "Not clear pronunciation",
      hint: "Not wrong, just not quite crisp. Slow down on these and land the vowel cleanly. Click a word to hear your version.",
      examples: notClear.slice(0, 8),
      count: notClear.length,
    });
  }
  if (omissions.length > 0) {
    pronunciationItems.push({
      label: "Skipped words",
      hint: "You missed these entirely. Read at a pace where your eye can look one word ahead — that stops you rushing past. No audio for skipped words.",
      examples: omissions.slice(0, 8),
      count: omissions.length,
    });
  }
  if (pronunciationItems.length === 0) {
    pronunciationItems.push({
      label: "Nothing to fix",
      hint: "Every word was clear. Try a harder passage or read from further away next time.",
      examples: [],
      count: 0,
    });
  }

  const fluencyItems: TipItem[] = [];
  if (breakdown.fluency.paceVerdict === "too fast") {
    fluencyItems.push({
      label: "Slow down",
      hint: `You read at ${breakdown.fluency.wpm} words/min. PSLE examiners want 130–150 — enough time for each word to land, not a race. Imagine you're telling the story to a five-year-old.`,
      examples: [], count: 0,
    });
  } else if (breakdown.fluency.paceVerdict === "brisk") {
    fluencyItems.push({
      label: "Pace is a bit fast",
      hint: `${breakdown.fluency.wpm} words/min — the target is 130–150. Ease off slightly at commas so the marker can follow the meaning.`,
      examples: [], count: 0,
    });
  } else if (breakdown.fluency.paceVerdict === "too slow") {
    fluencyItems.push({
      label: "Build up speed",
      hint: `You read at ${breakdown.fluency.wpm} words/min — slower than the 130–150 target. Practise reading the passage aloud twice before recording so the words feel familiar.`,
      examples: [], count: 0,
    });
  } else if (breakdown.fluency.paceVerdict === "on target") {
    fluencyItems.push({
      label: "Pace on target",
      hint: `${breakdown.fluency.wpm} words/min — right in the PSLE sweet spot. Keep it here.`,
      examples: [], count: 0,
    });
  }
  if (unexpectedBreak.length > 0) {
    fluencyItems.push({
      label: "Unexpected pauses (mid-phrase)",
      hint: "You paused where the meaning shouldn't break. Read a whole clause in one breath and only stop at commas / full stops. Click a word to hear where you hesitated.",
      examples: unexpectedBreak.slice(0, 8),
      count: unexpectedBreak.length,
    });
  }
  if (missingBreak.length > 0) {
    fluencyItems.push({
      label: "Missing pauses at natural breaks",
      hint: "A small pause after commas helps the meaning land. Aim for a soft breath at every comma and full stop.",
      examples: missingBreak.slice(0, 8),
      count: missingBreak.length,
    });
  }
  if (fluencyItems.length === 0) {
    fluencyItems.push({
      label: "Fluent read",
      hint: "Natural pace, chunking felt right. Keep this rhythm on longer passages.",
      examples: [], count: 0,
    });
  }

  const expressivenessItems: TipItem[] = [];
  if (breakdown.expressiveness.intonationVerdict === "flat") {
    expressivenessItems.push({
      label: "Add pitch variety",
      hint: "Your voice stayed at one pitch too long — the read sounded flat. Try lifting on content words (Hakim, coconuts, grandma) and dropping on the little ones (a, the, of). Read it like a bedtime story, not a shopping list.",
      examples: [], count: 0,
    });
  } else if (breakdown.expressiveness.intonationVerdict === "some variation") {
    expressivenessItems.push({
      label: "Push the expression further",
      hint: "You had some pitch change but the marker wants more. Really enjoy the story — sound excited when the character is, sound worried when they are. Overact it in practice; it'll come across as natural in the real read.",
      examples: [], count: 0,
    });
  } else if (breakdown.expressiveness.intonationVerdict === "good variation") {
    expressivenessItems.push({
      label: "Great expression",
      hint: "Pitch moved naturally with the meaning. This is the level PSLE examiners want — keep telling the story like this.",
      examples: [], count: 0,
    });
  }
  if (monotone.length > 0) {
    expressivenessItems.push({
      label: "Monotone stretches — inflect here",
      hint: "The examiner flagged these words as sung on one note. Read them again lifting the pitch on the important syllable, or dropping it if it's a full-stop word.",
      examples: monotone.slice(0, 8),
      count: monotone.length,
    });
  }
  if (expressivenessItems.length === 0) {
    expressivenessItems.push({
      label: "Nothing flagged",
      hint: "No monotone stretches detected. Keep it up.",
      examples: [], count: 0,
    });
  }

  return [
    { key: "blue",   title: "Pronunciation",     tone: "blue",   items: pronunciationItems },
    { key: "purple", title: "Fluency & Rhythm",  tone: "purple", items: fluencyItems },
    { key: "brown",  title: "Expressiveness",    tone: "brown",  items: expressivenessItems },
  ];
}

function styleFor(score: number, error: string): { className: string; showScore: boolean } {
  // Strong reads stay in plain black type so the visual noise stays
  // low — only actual problems get colour treatment.
  if (error === "Omission")   return { className: "text-slate-400 line-through", showScore: false };
  if (error === "Insertion")  return { className: "text-purple-600 underline decoration-dotted", showScore: false };
  if (score >= 85)            return { className: "text-slate-800", showScore: false };
  if (score >= 60)            return { className: "text-amber-600 font-semibold", showScore: true };
  return { className: "text-rose-600 font-semibold", showScore: true };
}

// Rebuild the passage as a list of "chunks" — each chunk is either a
// word (matched to an Azure WordScore) or a punctuation/whitespace run
// (rendered as-is in default styling).
//
// Key robustness tweaks over the naive walker:
//
// 1. Contractions and hyphens stay together in one token
//    ("Hakim's" / "well-known" / "isn't" → single word tokens).
//    Azure returns these as one word too, so alignment stays 1:1.
//
// 2. Comparison ignores case AND apostrophes/hyphens
//    (normalize("Hakim's") === normalize("Hakims")). This survives
//    curly-vs-straight-quote OCR variance in the source passage.
//
// 3. Strict parallel walk. Each passage word tries to match the NEXT
//    queued Azure word first. Only if the immediate next mismatches do
//    we look ahead up to 3 positions for the true match (rare — mostly
//    just handles a stray Azure Insertion inline).
//
// 4. Azure's own Omission / Insertion errorType is authoritative — we
//    don't overwrite it. When Azure returns 0 insertions + 0 omissions
//    (clean read), the passage renders with 0 grey + 0 purple chunks.
function alignPassageWithWords(passage: string, words: WordScore[]): Array<
  | { kind: "word"; text: string; style: WordScore }
  | { kind: "gap"; text: string }
> {
  const chunks: Array<{ kind: "word"; text: string; style: WordScore } | { kind: "gap"; text: string }> = [];
  // A "word" = a run of letters/digits, optionally followed by
  // ('|’|‘|-|—) + more letters/digits — so contractions and hyphens
  // stay together. Everything else is a "gap".
  const wordRegex = /[A-Za-z0-9]+(?:[''’‘\-—][A-Za-z0-9]+)*|[^A-Za-z0-9]+/g;
  const tokens = passage.match(wordRegex) ?? [];
  const isWordToken = (t: string) => /^[A-Za-z0-9]/.test(t);
  const normalise = (t: string) => t.toLowerCase().replace(/[''’‘\-—]/g, "");

  const wordQueue = words.slice();
  const LOOKAHEAD = 3;

  for (const tok of tokens) {
    if (!isWordToken(tok)) {
      chunks.push({ kind: "gap", text: tok });
      continue;
    }

    // 1. Emit any leading Insertions from the queue as insertions
    //    BEFORE this passage token — those are extras the student
    //    added, and Azure has marked them as such.
    while (wordQueue.length > 0 && wordQueue[0].errorType === "Insertion") {
      const ins = wordQueue.shift()!;
      chunks.push({ kind: "word", text: ins.word, style: ins });
      chunks.push({ kind: "gap", text: " " });
    }

    if (wordQueue.length === 0) {
      // Passage has more words than Azure returned — treat as skipped.
      chunks.push({ kind: "word", text: tok, style: {
        word: tok, accuracyScore: 0, errorType: "Omission",
        breakErrors: [], intonationErrors: [],
      }});
      continue;
    }

    const nTok = normalise(tok);
    // 2. Immediate next Azure word matches? (Fast path — the common
    //    case for a clean read.)
    if (normalise(wordQueue[0].word) === nTok) {
      const az = wordQueue.shift()!;
      chunks.push({ kind: "word", text: tok, style: az });
      continue;
    }

    // 3. Short look-ahead for a match — handles the occasional stray
    //    Azure ordering hiccup. Anything before the match is treated
    //    as its actual Azure errorType (Insertion / Mispronunciation).
    let matchedIdx = -1;
    for (let i = 1; i < Math.min(wordQueue.length, LOOKAHEAD + 1); i++) {
      if (normalise(wordQueue[i].word) === nTok) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx > 0) {
      for (let i = 0; i < matchedIdx; i++) {
        const w = wordQueue[i];
        chunks.push({ kind: "word", text: w.word, style: w });
        chunks.push({ kind: "gap", text: " " });
      }
      const az = wordQueue[matchedIdx];
      wordQueue.splice(0, matchedIdx + 1);
      chunks.push({ kind: "word", text: tok, style: az });
      continue;
    }

    // 4. No match nearby. Rather than desync the rest of the passage,
    //    just render this passage word using the next Azure entry's
    //    style (preserves its score + errorType) and move on. Small
    //    number of visual mismatches beats cascading grey/purple.
    const az = wordQueue.shift()!;
    chunks.push({ kind: "word", text: tok, style: { ...az, word: tok } });
  }

  // Any leftover Azure words are trailing extras — mark as Insertion
  // ONLY if Azure didn't already give them a specific errorType.
  for (const w of wordQueue) {
    chunks.push({ kind: "gap", text: " " });
    const isReallyInsertion = w.errorType === "Insertion" || w.errorType === "None";
    chunks.push({
      kind: "word",
      text: w.word,
      style: isReallyInsertion ? { ...w, errorType: "Insertion" } : w,
    });
  }
  return chunks;
}

function ColouredPassage({ passage, words, onPlayWord }: { passage: string; words: WordScore[]; onPlayWord?: (w: WordScore) => void }) {
  const chunks = alignPassageWithWords(passage, words);
  return (
    <p className="text-slate-800 text-lg leading-loose whitespace-pre-wrap">
      {chunks.map((c, i) => {
        if (c.kind === "gap") return <span key={i}>{c.text}</span>;
        const s = styleFor(c.style.accuracyScore, c.style.errorType);
        const isProblem = c.style.errorType !== "None" || c.style.accuracyScore < 85;
        const canPlay = !!onPlayWord && isProblem && c.style.errorType !== "Omission";
        if (canPlay) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPlayWord?.(c.style)}
              className={`${s.className} hover:bg-slate-100 rounded px-0.5 cursor-pointer`}
              title="Click to hear your reading of this word"
            >
              {c.text}
              {s.showScore && (
                <span className="text-xs align-super ml-0.5 opacity-70">{Math.round(c.style.accuracyScore)}</span>
              )}
            </button>
          );
        }
        return (
          <span key={i} className={s.className}>
            {c.text}
            {s.showScore && (
              <span className="text-xs align-super ml-0.5 opacity-70">{Math.round(c.style.accuracyScore)}</span>
            )}
          </span>
        );
      })}
      <span className="block text-xs text-slate-400 mt-4 not-italic">
        Legend:
        <span className="inline-block ml-2 text-amber-600 font-semibold">amber = not clear pronunciation</span>
        <span className="inline-block ml-3 text-rose-600 font-semibold">red = mispronounced</span>
        <span className="inline-block ml-3 text-slate-400 line-through">skipped</span>
        <span className="inline-block ml-3 text-purple-600 underline decoration-dotted">extra word</span>
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

type ToneKey = "blue" | "purple" | "brown";
const TONE_STYLES: Record<ToneKey, { border: string; bg: string; text: string; label: string; softBg: string; softBorder: string }> = {
  blue:   { border: "border-blue-200",   bg: "bg-blue-50",   text: "text-blue-700",   label: "text-blue-600",   softBg: "bg-blue-50/60",   softBorder: "border-blue-200" },
  purple: { border: "border-purple-200", bg: "bg-purple-50", text: "text-purple-700", label: "text-purple-600", softBg: "bg-purple-50/60", softBorder: "border-purple-200" },
  brown:  { border: "border-amber-300",  bg: "bg-amber-50",  text: "text-amber-800",  label: "text-amber-700",  softBg: "bg-amber-50/60",  softBorder: "border-amber-300" },
};

function SeabDim({ label, value, outOf, desc, tone }: { label: string; value: number; outOf: number; desc: string; tone: ToneKey }) {
  const s = TONE_STYLES[tone];
  return (
    <div className={`rounded-xl ${s.bg} border ${s.border} p-3`}>
      <p className={`text-[10px] uppercase tracking-wide ${s.label} font-semibold`}>{label}</p>
      <p className={`text-xl font-bold ${s.text}`}>
        {Math.round(value)}
        <span className="text-[10px] text-slate-500 ml-1">({value.toFixed(1)})</span>
        <span className="text-xs text-slate-500 ml-1">/ {outOf}</span>
      </p>
      <p className={`text-[10px] mt-0.5 ${s.label}`}>{desc}</p>
    </div>
  );
}

function DetailedScoring({ score }: { score: ScoreSummary }) {
  const b = score.breakdown;
  return (
    <div>
      <h3 className="text-sm font-bold text-slate-800 mb-3">Detailed Scoring</h3>
      <div className="space-y-3">
        {/* Pronunciation — blue */}
        <div className={`rounded-xl border ${TONE_STYLES.blue.softBorder} ${TONE_STYLES.blue.softBg} p-4`}>
          <p className={`text-xs font-bold uppercase tracking-wide ${TONE_STYLES.blue.text} mb-2`}>Pronunciation — {Math.round(score.seab.pronunciation)} / 8</p>
          <p className="text-xs text-slate-700 leading-relaxed">
            Of <strong>{b.pronunciation.total}</strong> words in the passage,
            you read <strong>{b.pronunciation.clear}</strong> clearly,
            <strong> {b.pronunciation.notClear}</strong> not clearly,
            <strong> {b.pronunciation.mispronounced}</strong> mispronounced,
            <strong> {b.pronunciation.omitted}</strong> skipped,
            and added <strong>{b.pronunciation.inserted}</strong> extra {b.pronunciation.inserted === 1 ? "word" : "words"}.
          </p>
          <p className="text-[10px] text-slate-500 mt-2">
            The examiner scores each phoneme (single sound like &quot;th&quot; or &quot;str&quot;) against the expected phoneme,
            then averages phonemes into a word score. A poorly-scored word usually means at least one phoneme was wrong or missing.
          </p>
        </div>

        {/* Fluency & Rhythm — purple */}
        <div className={`rounded-xl border ${TONE_STYLES.purple.softBorder} ${TONE_STYLES.purple.softBg} p-4`}>
          <p className={`text-xs font-bold uppercase tracking-wide ${TONE_STYLES.purple.text} mb-2`}>Fluency &amp; Rhythm — {Math.round(score.seab.fluencyRhythm)} / 6</p>
          <p className="text-xs text-slate-700 leading-relaxed">
            You read at <strong>{b.fluency.wpm > 0 ? `${b.fluency.wpm} words/min` : "—"}</strong>
            {b.fluency.wpm > 0 && (
              <> — that&apos;s <strong>{
                b.fluency.paceVerdict === "on target" ? "on-target for PSLE oral (130–150)" :
                b.fluency.paceVerdict === "brisk" ? "a bit brisk (150–170)" :
                b.fluency.paceVerdict === "too fast" ? "too fast (> 170)" :
                b.fluency.paceVerdict === "too slow" ? "too slow (< 100)" : "hard to judge"
              }</strong></>
            )}. You made <strong>{b.fluency.unexpectedPauses}</strong> unexpected {b.fluency.unexpectedPauses === 1 ? "pause" : "pauses"} (mid-clause hesitation)
            and missed <strong>{b.fluency.missingPauses}</strong> {b.fluency.missingPauses === 1 ? "pause" : "pauses"} at natural breaks.
          </p>
          <p className="text-[10px] text-slate-500 mt-2">
            The examiner measures pace consistency + pause placement + filler words. PSLE examiners want natural chunking — a soft breath at commas, no rushing through phrases.
          </p>
        </div>

        {/* Expressiveness — brown/amber */}
        <div className={`rounded-xl border ${TONE_STYLES.brown.softBorder} ${TONE_STYLES.brown.softBg} p-4`}>
          <p className={`text-xs font-bold uppercase tracking-wide ${TONE_STYLES.brown.text} mb-2`}>Expressiveness — {Math.round(score.seab.expressiveness)} / 6</p>
          <p className="text-xs text-slate-700 leading-relaxed">
            Your intonation was <strong>{
              b.expressiveness.intonationVerdict === "good variation" ? "varied and natural — pitch moved with meaning" :
              b.expressiveness.intonationVerdict === "some variation" ? "adequate — some pitch change, but flat in places" :
              b.expressiveness.intonationVerdict === "flat" ? "mostly flat — voice stayed at one pitch too much" :
              "not detected"
            }</strong>. The examiner flagged <strong>{b.expressiveness.monotoneWords}</strong> {b.expressiveness.monotoneWords === 1 ? "word" : "words"} as monotone stretches.
          </p>
          <p className="text-[10px] text-slate-500 mt-2">
            Expression scoring looks at four things: pitch pattern (rising for questions, falling for full stops), word-level stress (content words louder than function words),
            pace variation (slow at commas, faster in enumeration), and pause placement. A monotone-flagged word means the pitch didn&apos;t move where a natural reader would inflect.
          </p>
        </div>
      </div>
    </div>
  );
}

function TipsBlock({ words, breakdown, onPlayWord }: { words: WordScore[]; breakdown: Breakdown; onPlayWord?: (w: WordScore) => void }) {
  const categories = buildTips(words, breakdown);
  return (
    <div>
      <h3 className="text-sm font-bold text-slate-800 mb-3">Tips to improve — by SEAB dimension</h3>
      <div className="space-y-4">
        {categories.map((cat) => {
          const s = TONE_STYLES[cat.tone];
          return (
            <div key={cat.key} className={`rounded-xl border ${s.softBorder} ${s.softBg} p-4`}>
              <p className={`text-xs font-bold uppercase tracking-wide ${s.text} mb-3`}>{cat.title}</p>
              <div className="space-y-3">
                {cat.items.map((item, i) => (
                  <div key={i} className="rounded-lg bg-white/70 border border-white/50 p-3">
                    <div className="flex items-baseline justify-between mb-1">
                      <p className={`text-sm font-semibold ${s.text}`}>{item.label}</p>
                      {item.count > 0 && (
                        <span className="text-[10px] text-slate-500">{item.count} {item.count === 1 ? "word" : "words"}</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-700 leading-relaxed mb-2">{item.hint}</p>
                    {item.examples.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {item.examples.map((w, j) => {
                          const canPlay = onPlayWord && w.errorType !== "Omission";
                          return (
                            <button
                              key={j}
                              type="button"
                              disabled={!canPlay}
                              onClick={() => canPlay && onPlayWord?.(w)}
                              className={`text-xs px-2 py-1 rounded-lg inline-flex items-center gap-1 ${s.bg} ${s.text} ${canPlay ? "hover:opacity-80 cursor-pointer" : "opacity-70 cursor-not-allowed"} border ${s.border}`}
                              title={canPlay ? "Click to hear your reading of this word" : "Skipped word — no audio to play"}
                            >
                              {canPlay && <span className="text-[10px]">▶</span>}
                              <span>{w.word}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
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
