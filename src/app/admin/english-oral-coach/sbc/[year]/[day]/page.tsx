"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { ExaminerAvatar } from "@/components/ExaminerAvatar";

// SBC live-voice module. The examiner is Gemini Live (audio in + audio
// out, WebSocket). The student's audio is captured via the browser mic
// and streamed to Gemini; Gemini streams back synthesised examiner
// audio which we play through an <audio> element. Both directions are
// transcribed and stored so we can score at the end.
//
// The Gemini Live SDK is loaded dynamically (window-scoped).

export default function SbcPage() {
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

type TranscriptTurn = { speaker: "examiner" | "student"; text: string; ts: number };

type DimTip = { label: string; hint: string; examples: string[] };
type DimBlock = {
  scoreOutOf: number;
  verdict: string;
  seabLooksFor: string;
  details: string[];
  tips: DimTip[];
};
type SbcScore = {
  overallSeabScore: number;
  overallVerdict: string;
  personalResponse: DimBlock;
  languageUse: DimBlock;
  speakingStyle: DimBlock;
  modelUpgradeExample: string;
};

function Inner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const year = String(params.year);
  const dayNum = Number(params.day);
  const userId = searchParams.get("userId") ?? "";

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [passage, setPassage] = useState<PassageDay | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "connecting" | "live" | "ending" | "scoring" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [examinerSpeaking, setExaminerSpeaking] = useState(false);
  const [score, setScore] = useState<SbcScore | null>(null);
  const sessionRef = useRef<unknown>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  useEffect(() => {
    if (!allowed) return;
    fetch(`/api/admin/english-oral-coach/read?userId=${userId}&year=${year}&day=${dayNum}`)
      .then(async r => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then((json: { day: PassageDay | null }) => {
        if (!json.day) throw new Error("No day data found.");
        setPassage(json.day);
        setStatus("ready");
      })
      .catch((e: Error) => { setError(e.message); setStatus("error"); });
  }, [allowed, userId, year, dayNum]);

  async function start() {
    if (!passage) return;
    setError(null);
    setScore(null);
    setTranscript([]);
    setStatus("connecting");
    try {
      const tokenResp = await fetch("/api/oral-coach/gemini-live-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, day: dayNum }),
      });
      if (!tokenResp.ok) {
        // Try to parse the JSON error we return; if it's an HTML Cloudflare
        // 502 page instead, fall back to a generic message.
        const raw = await tokenResp.text();
        let msg = `Session start failed (${tokenResp.status})`;
        try {
          const parsed = JSON.parse(raw);
          msg = parsed.error || msg;
          if (parsed.hint) msg = `${msg}\n\n${parsed.hint}`;
        } catch {
          if (tokenResp.status === 502 || raw.trim().startsWith("<")) {
            msg = "Session start timed out — Gemini Live may not be enabled on the AI Studio project this API key belongs to. Ask the admin to enable Live API access, or upgrade the project to a paid tier.";
          }
        }
        throw new Error(msg);
      }
      const { token, model } = await tokenResp.json();

      const mod = await import("@google/genai");
      const client = new mod.GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
      const session = await client.live.connect({
        model,
        config: {
          responseModalities: [mod.Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => setStatus("live"),
          onmessage: (msg: unknown) => handleLiveMessage(msg),
          onerror: (e: unknown) => { setError(String(e)); setStatus("error"); },
          onclose: () => {
            if (status === "live") setStatus("ending");
          },
        },
      });
      sessionRef.current = session;

      // Start capturing mic and streaming into the session.
      await startMicStream(session);
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }

  function handleLiveMessage(msg: unknown) {
    // Gemini Live server messages arrive here — transcriptions, audio
    // chunks, turnComplete signals. We wire the transcripts into the
    // transcript state; audio playback + mic streaming are handled by
    // startMicStream() and the session's built-in audio pipeline.
    const m = msg as {
      serverContent?: {
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        modelTurn?: unknown;
        turnComplete?: boolean;
      };
    };
    const inText = m.serverContent?.inputTranscription?.text;
    const outText = m.serverContent?.outputTranscription?.text;
    if (inText) {
      setTranscript((prev) => appendOrExtend(prev, "student", inText));
    }
    if (outText) {
      setTranscript((prev) => appendOrExtend(prev, "examiner", outText));
      setExaminerSpeaking(true);
    }
    if (m.serverContent?.turnComplete) setExaminerSpeaking(false);
  }

  async function startMicStream(session: unknown) {
    // Access mic, wire audio chunks into session.sendRealtimeInput.
    // The @google/genai live session accepts 16kHz PCM chunks; we run a
    // Web Audio API worklet to downsample the mic stream.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioContext.destination);
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
      const s = session as { sendRealtimeInput: (arg: { media: { data: string; mimeType: string } }) => void };
      s.sendRealtimeInput({
        media: {
          data: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))),
          mimeType: "audio/pcm;rate=16000",
        },
      });
    };
  }

  async function endAndScore() {
    if (!passage) return;
    setStatus("ending");
    const s = sessionRef.current as { close?: () => void } | null;
    if (s?.close) s.close();
    setStatus("scoring");
    try {
      const resp = await fetch("/api/oral-coach/sbc-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          stimulus: passage.stimulusDescription,
          prompts: passage.conversationPrompts,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data: SbcScore = await resp.json();
      setScore(data);
      setStatus("done");
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }

  if (allowed === null) return <FullPageSpinner />;
  if (!allowed) return <FullPageDenied />;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <Link href={`/admin/english-oral-coach?userId=${userId}`} className="text-slate-400 hover:text-slate-600 text-xs">← Oral Coach</Link>
          <h1 className="text-lg font-bold text-slate-800">Stimulus-Based Conversation — {year} · Day {dayNum}</h1>
        </div>

        <div className="max-w-4xl mx-auto px-4 py-3 space-y-2">
          {status === "loading" && <Card>Loading…</Card>}
          {status === "error" && <Card><p className="text-rose-600 text-sm">{error}</p></Card>}

          {passage && (
            <>
              {/* Avatar row first — examiner is the primary presence.
                  The stimulus description text has been dropped per
                  UX request; the picture below carries all the visual
                  context needed. */}
              {/* Avatar row — examiner presence + action buttons. No
                  description text; the picture below carries context. */}
              <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3 flex items-center gap-3">
                <ExaminerAvatar
                  speaking={examinerSpeaking}
                  className="w-32 h-32 rounded-xl bg-slate-100 flex-shrink-0 ring-2 ring-white shadow"
                />
                <div className="flex-1">
                  <p className="text-xs text-slate-700 leading-relaxed">Speak naturally — the examiner asks one random prompt from the day&apos;s three plus follow-ups. Aim for a 3-4 minute conversation. Take your time thinking; the examiner will wait.</p>
                </div>
                {status === "ready" && (
                  <button onClick={start} className="bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700">Start Session</button>
                )}
                {(status === "connecting" || status === "live") && (
                  <button onClick={endAndScore} className="bg-rose-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold">End & Score</button>
                )}
                {status === "scoring" && <span className="text-sm text-slate-500">Scoring…</span>}
                {status === "done" && (
                  <button onClick={() => { setScore(null); setTranscript([]); setStatus("ready"); }} className="bg-slate-800 text-white px-5 py-2.5 rounded-xl text-sm font-semibold">Try again</button>
                )}
              </div>

              {/* Stimulus picture — below the avatar, no caption. */}
              <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-2">
                <StimulusImage year={year} day={dayNum} description={passage.stimulusDescription} />
              </div>

              {/* Live transcript */}
              {transcript.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-2">Live Transcript</p>
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {transcript.map((t, i) => (
                      <div key={i} className={`flex ${t.speaker === "student" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[80%] rounded-xl px-2.5 py-1.5 text-xs ${t.speaker === "student" ? "bg-indigo-50 text-indigo-900" : "bg-emerald-50 text-emerald-900"}`}>
                          <p className="text-[9px] uppercase tracking-wide opacity-60 mb-0.5">{t.speaker}</p>
                          <p>{t.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {score && <SbcScoreCard score={score} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type ToneKey = "blue" | "purple" | "brown";
const TONE: Record<ToneKey, { bg: string; border: string; text: string; label: string; softBg: string; softBorder: string }> = {
  blue:   { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-700",   label: "text-blue-600",   softBg: "bg-blue-50/60",   softBorder: "border-blue-200" },
  purple: { bg: "bg-purple-50", border: "border-purple-200", text: "text-purple-700", label: "text-purple-600", softBg: "bg-purple-50/60", softBorder: "border-purple-200" },
  brown:  { bg: "bg-amber-50",  border: "border-amber-300",  text: "text-amber-800",  label: "text-amber-700",  softBg: "bg-amber-50/60",  softBorder: "border-amber-300" },
};

function SbcScoreCard({ score }: { score: SbcScore }) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3 space-y-2">
      {/* Matrix — total + 3 SEAB dimensions */}
      <div>
        <h2 className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-1.5">SEAB SBC Scoring Matrix</h2>
        <div className="rounded-lg bg-gradient-to-br from-slate-50 to-white border border-slate-200 p-2.5">
          <div className="flex items-end gap-2">
            <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold pb-1">Predicted total</p>
            <span className="text-3xl font-bold text-slate-800 leading-none">{score.overallSeabScore}</span>
            <span className="text-sm text-slate-500 pb-0.5">/ 30</span>
          </div>
          <p className="text-xs text-slate-600 mt-1.5 leading-snug">{score.overallVerdict}</p>
          <div className="grid grid-cols-3 gap-2 mt-2">
            <SbcSeabDim label="Personal Response" value={score.personalResponse.scoreOutOf} outOf={12} tone="blue"   desc="stance, reasoning, examples" />
            <SbcSeabDim label="Language Use"      value={score.languageUse.scoreOutOf}      outOf={12} tone="purple" desc="grammar, vocab, connectives" />
            <SbcSeabDim label="Speaking Style"    value={score.speakingStyle.scoreOutOf}    outOf={6}  tone="brown"  desc="fluency, engagement" />
          </div>
        </div>
      </div>

      {/* Detailed Scoring — per dimension */}
      <div>
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-1.5">Detailed Scoring</h3>
        <div className="space-y-1.5">
          <SbcDimCard title="Personal Response" outOf={12} block={score.personalResponse} tone="blue" />
          <SbcDimCard title="Language Use"      outOf={12} block={score.languageUse}      tone="purple" />
          <SbcDimCard title="Speaking Style"    outOf={6}  block={score.speakingStyle}    tone="brown" />
        </div>
      </div>

      {/* Tips per dimension */}
      <div>
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-1.5">Tips to improve — by SEAB dimension</h3>
        <div className="space-y-1.5">
          <SbcTipsCategory title="Personal Response" tone="blue"   tips={score.personalResponse.tips} />
          <SbcTipsCategory title="Language Use"      tone="purple" tips={score.languageUse.tips} />
          <SbcTipsCategory title="Speaking Style"    tone="brown"  tips={score.speakingStyle.tips} />
        </div>
      </div>

      {/* Model upgrade */}
      <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5">
        <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide mb-1">Model upgrade — how your weakest answer could have sounded</p>
        <p className="text-xs text-slate-800 leading-relaxed">{score.modelUpgradeExample}</p>
      </div>
    </div>
  );
}

function SbcSeabDim({ label, value, outOf, desc, tone }: { label: string; value: number; outOf: number; desc: string; tone: ToneKey }) {
  const s = TONE[tone];
  return (
    <div className={`rounded-lg ${s.bg} border ${s.border} px-2 py-1.5`}>
      <p className={`text-[10px] uppercase tracking-wide ${s.label} font-semibold`}>{label}</p>
      <p className={`text-lg font-bold leading-none ${s.text}`}>
        {value}<span className="text-[10px] text-slate-500 ml-1">/ {outOf}</span>
      </p>
      <p className={`text-[10px] mt-0.5 ${s.label}`}>{desc}</p>
    </div>
  );
}

function SbcDimCard({ title, outOf, block, tone }: { title: string; outOf: number; block: DimBlock; tone: ToneKey }) {
  const s = TONE[tone];
  return (
    <div className={`rounded-lg border ${s.softBorder} ${s.softBg} p-2.5`}>
      <p className={`text-[10px] font-bold uppercase tracking-wide ${s.text} mb-1`}>{title} — {block.scoreOutOf} / {outOf}</p>
      <p className="text-xs text-slate-700 leading-snug mb-1 font-semibold">{block.verdict}</p>
      <p className="text-[10px] text-slate-500 italic leading-snug mb-1">What SEAB looks for: {block.seabLooksFor}</p>
      {block.details.length > 0 && (
        <ul className="text-[11px] text-slate-700 leading-snug list-disc ml-3.5 space-y-0.5">
          {block.details.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}
    </div>
  );
}

function SbcTipsCategory({ title, tone, tips }: { title: string; tone: ToneKey; tips: DimTip[] }) {
  const s = TONE[tone];
  if (tips.length === 0) return null;
  return (
    <div className={`rounded-lg border ${s.softBorder} ${s.softBg} p-2.5`}>
      <p className={`text-[10px] font-bold uppercase tracking-wide ${s.text} mb-1.5`}>{title}</p>
      <div className="space-y-1.5">
        {tips.map((t, i) => (
          <div key={i} className="rounded-md bg-white/70 border border-white/50 p-2">
            <p className={`text-xs font-semibold ${s.text} mb-0.5`}>{t.label}</p>
            <p className="text-[11px] text-slate-700 leading-snug mb-1">{t.hint}</p>
            {t.examples.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {t.examples.map((ex, j) => (
                  <span key={j} className={`text-[10px] px-1.5 py-0.5 rounded ${s.bg} ${s.text} border ${s.border} italic`}>&ldquo;{ex}&rdquo;</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StimulusImage({ year, day, description }: { year: string; day: number; description: string }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/admin/english-oral-coach/stimulus/${year}/${day}/image`;
  if (failed) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6">
        <p className="text-xs font-semibold text-amber-700 mb-2">Stimulus image not extracted yet</p>
        <p className="text-sm text-slate-700 leading-relaxed">{description}</p>
        <p className="text-xs text-slate-400 mt-3">
          Run <code className="bg-slate-100 px-1.5 py-0.5 rounded">npx tsx scripts/extract-oral-stimuli.ts</code> on Railway to backfill the cropped images.
        </p>
      </div>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt={description}
      onError={() => setFailed(true)}
      className="w-full max-h-[400px] object-contain rounded-lg bg-slate-50"
    />
  );
}

function appendOrExtend(prev: TranscriptTurn[], speaker: "examiner" | "student", text: string): TranscriptTurn[] {
  // Streaming transcriptions arrive as small deltas; if the last turn
  // was by the same speaker in the last ~3s, extend it. Else new turn.
  const now = Date.now();
  const last = prev[prev.length - 1];
  if (last && last.speaker === speaker && now - last.ts < 3000) {
    const next = prev.slice(0, -1);
    next.push({ ...last, text: last.text + text, ts: now });
    return next;
  }
  return [...prev, { speaker, text, ts: now }];
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
