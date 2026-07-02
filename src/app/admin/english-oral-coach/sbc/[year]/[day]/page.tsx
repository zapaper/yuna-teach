"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

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

type SbcScore = {
  perPromptScores: Array<{
    promptLabel: string;
    stanceClarity: number;
    reasonHead: number;
    pictureAnchor: number;
    anecdoteQuality: number;
    loopBack: number;
    valuesVocab: number;
    discourseMarkers: number;
    totalOutOf26: number;
    feedback: string;
  }>;
  overallSeabScore: number;
  strengths: string[];
  areasToImprove: string[];
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
      if (!tokenResp.ok) throw new Error(await tokenResp.text());
      const { token, model } = await tokenResp.json();

      const mod = await import("@google/genai");
      const client = new mod.GoogleGenAI({ apiKey: token, apiVersion: "v1alpha" });
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

        <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
          {status === "loading" && <Card>Loading…</Card>}
          {status === "error" && <Card><p className="text-rose-600 text-sm">{error}</p></Card>}

          {passage && (
            <>
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-4">
                <div className={`w-28 h-28 rounded-full flex items-center justify-center text-xs ${examinerSpeaking ? "bg-emerald-100 text-emerald-600 animate-pulse" : "bg-slate-100 text-slate-300"}`}>
                  {examinerSpeaking ? "Examiner\nspeaking" : "Examiner\n(listening)"}
                </div>
                <div className="flex-1">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Stimulus</p>
                  <p className="text-sm text-slate-700">{passage.stimulusDescription}</p>
                  <p className="text-[11px] text-slate-400 mt-1">3 prompts will be asked in order. Speak naturally — the examiner will follow up.</p>
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

              {/* Live transcript */}
              {transcript.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Live Transcript</p>
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {transcript.map((t, i) => (
                      <div key={i} className={`flex ${t.speaker === "student" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${t.speaker === "student" ? "bg-indigo-50 text-indigo-900" : "bg-emerald-50 text-emerald-900"}`}>
                          <p className="text-[10px] uppercase tracking-wide opacity-60 mb-0.5">{t.speaker}</p>
                          <p>{t.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Score card */}
              {score && (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-5">
                  <div className="flex items-center gap-4">
                    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                      <p className="text-[10px] uppercase tracking-wide text-slate-500">SEAB SBC score</p>
                      <p className="text-3xl font-bold text-indigo-700">{score.overallSeabScore}<span className="text-sm text-slate-400 ml-1">/30</span></p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wide">Strengths</p>
                      <ul className="text-sm text-slate-700 list-disc ml-4">{score.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-rose-600 uppercase tracking-wide mb-1">Areas to improve</p>
                    <ul className="text-sm text-slate-700 list-disc ml-4">{score.areasToImprove.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Per-prompt scores (out of 26)</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {score.perPromptScores.map((p, i) => (
                        <div key={i} className="rounded-xl border border-slate-200 p-3">
                          <p className="text-xs font-bold text-slate-700">Prompt {p.promptLabel}</p>
                          <p className="text-xl font-bold text-slate-900">{p.totalOutOf26}<span className="text-xs text-slate-400">/26</span></p>
                          <p className="text-[11px] text-slate-500 mt-1">{p.feedback}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                    <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Model upgrade example</p>
                    <p className="text-sm text-slate-800 leading-relaxed">{score.modelUpgradeExample}</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
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
