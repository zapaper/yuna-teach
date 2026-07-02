"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { ExaminerAvatar } from "@/components/ExaminerAvatar";
import { getOralAvatar, getOralAvatarKey } from "@/lib/oral-avatar";

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
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackNextTimeRef = useRef<number>(0);
  // Suppress Gemini's very first spoken turn. The Live API generates
  // one turn on session open no matter what the system instruction
  // says (it interprets the instruction as a cue to speak); that turn
  // ends up being a repeat/paraphrase of the opening prompt we just
  // spoke via TTS. Gate all Gemini audio + transcript on the student
  // actually having spoken first. Flip to true when we see the first
  // inputTranscription.
  const studentHasSpokenRef = useRef<boolean>(false);
  // Mic teardown refs — held so endAndScore / onclose / onerror can
  // stop the audio processor and release the mic. Without this, the
  // script processor keeps calling sendRealtimeInput on a closed
  // WebSocket and floods the console with "already CLOSING or CLOSED".
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionAliveRef = useRef<boolean>(false);
  // Counters to detect double-fires. If start() runs twice (React
  // strict mode re-render, double-click, or a state-transition bug)
  // both counters will show it. If Gemini's audio playback plays a
  // repeat of the prompt AFTER the TTS finishes, geminiAudioCount
  // will tick up while openerFireCount stays at 1.
  const openerFireCountRef = useRef<number>(0);
  const geminiAudioChunkCountRef = useRef<number>(0);

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
    console.log("[SBC opener] start() called at", new Date().toISOString(), "current status:", status);
    setError(null);
    setScore(null);
    setTranscript([]);
    studentHasSpokenRef.current = false;
    setStatus("connecting");
    try {
      const chosenGender = getOralAvatar(getOralAvatarKey()).gender;
      const tokenResp = await fetch("/api/oral-coach/gemini-live-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, day: dayNum, gender: chosenGender }),
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
      const { token, model, selectedPrompt } = await tokenResp.json();
      const gender = chosenGender;

      // Playback pipeline for Gemini's audio replies. Gemini Live
      // returns 24kHz PCM (16-bit signed little-endian) — build a
      // dedicated AudioContext at that rate and stitch incoming
      // buffers back-to-back so playback stays gap-free even when
      // the server splits a single utterance across many chunks.
      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
      playbackNextTimeRef.current = 0;

      // Speak the opener via browser TTS FIRST — BEFORE opening the
      // Live session. If we open Live first, Gemini receives its
      // system instruction and immediately generates an opening
      // spoken turn (repeating the prompt) that plays over the TTS.
      // Delaying the Live connection until after TTS ends means
      // Gemini's very first input is real student audio, so it can
      // only respond as a follow-up.
      const opener = `Hello! Let's have a chat about this picture. ${selectedPrompt}`;
      console.log("[SBC opener] FIRING TTS #", ++openerFireCountRef.current, "gender:", gender, ":", opener);
      setTranscript([{ speaker: "examiner", text: opener, ts: Date.now() }]);
      setExaminerSpeaking(true);
      setStatus("live");
      await speakOpener(opener, gender);
      console.log("[SBC opener] TTS finished #", openerFireCountRef.current);
      setExaminerSpeaking(false);

      // Now connect the Live session. The system instruction tells
      // Gemini its first turn must be a reaction to what the student
      // says next — which is what will actually arrive first through
      // the mic stream we start immediately below.
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
          onopen: () => {
            sessionAliveRef.current = true;
            console.log("[SBC live] session OPEN");
          },
          onmessage: (msg: unknown) => handleLiveMessage(msg),
          onerror: (e: unknown) => {
            console.error("[SBC live] session ERROR", e);
            sessionAliveRef.current = false;
            teardownMic();
            const errObj = e as { message?: string; reason?: string; code?: number; error?: unknown };
            const errText = errObj?.message || errObj?.reason || JSON.stringify(errObj) || String(e);
            setError(`Live session error: ${errText}`);
            setStatus("error");
          },
          onclose: (ev: unknown) => {
            // Log inline so DevTools shows the reason without needing
            // to expand a collapsed Object. The reason string is the
            // most useful diagnostic — it carries the model / auth /
            // config rejection message from the server.
            const c = ev as { code?: number; reason?: string; wasClean?: boolean };
            const msg = `code=${c?.code ?? "?"} clean=${c?.wasClean ?? "?"} reason="${c?.reason ?? "(none)"}"`;
            console.log("[SBC live] session CLOSE", msg);
            if (c?.reason) {
              // Also surface to the UI so the user sees why it failed
              // without having to open DevTools.
              setError(`Live session closed: ${c.reason}`);
              setStatus("error");
            }
            sessionAliveRef.current = false;
            teardownMic();
            if (status === "live" && !c?.reason) setStatus("ending");
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
    // chunks, turnComplete signals. Gate all examiner output on the
    // student having spoken at least once: Gemini's first turn on
    // session open is a hardcoded prompt-repeat regardless of what
    // the system instruction says, and we don't want it to reach the
    // student's ears or the transcript.
    const m = msg as {
      serverContent?: {
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
        turnComplete?: boolean;
        interrupted?: boolean;
        waitingForInput?: boolean;
      };
      setupComplete?: unknown;
    };
    // High-signal debug logging — filter out per-chunk audio noise
    // (dozens per second) but log everything else so we can trace
    // why the student's speech isn't being transcribed.
    const hasAudio = !!(m.serverContent?.modelTurn?.parts?.some((p) => p.inlineData?.data));
    const shape = {
      setupComplete: !!m.setupComplete,
      inText: m.serverContent?.inputTranscription?.text,
      outText: m.serverContent?.outputTranscription?.text,
      hasAudio,
      turnComplete: m.serverContent?.turnComplete,
      interrupted: m.serverContent?.interrupted,
      waitingForInput: m.serverContent?.waitingForInput,
    };
    if (shape.setupComplete || shape.inText || shape.outText || shape.turnComplete || shape.interrupted || shape.waitingForInput) {
      console.log("[SBC live]", shape);
    }
    const inText = m.serverContent?.inputTranscription?.text;
    const outText = m.serverContent?.outputTranscription?.text;
    if (inText) {
      studentHasSpokenRef.current = true;
      setTranscript((prev) => appendOrExtend(prev, "student", inText));
    }
    if (!studentHasSpokenRef.current) {
      // Silently drop any examiner audio/transcript before the
      // student's first utterance. This is Gemini's hardcoded
      // opening turn — we already spoke the intended opener via TTS.
      if (hasAudio) console.log("[SBC live] dropping pre-student examiner audio");
      if (m.serverContent?.turnComplete) setExaminerSpeaking(false);
      return;
    }
    if (outText) {
      setTranscript((prev) => appendOrExtend(prev, "examiner", outText));
      setExaminerSpeaking(true);
    }
    const parts = m.serverContent?.modelTurn?.parts ?? [];
    for (const part of parts) {
      const b64 = part.inlineData?.data;
      if (b64) {
        geminiAudioChunkCountRef.current++;
        // Log first chunk of every Gemini audio turn (chunks arrive
        // in bursts of ~10-50; log #1, #10, #100... so we see when
        // Gemini starts speaking without spamming).
        const n = geminiAudioChunkCountRef.current;
        if (n === 1 || n === 10 || n === 100 || n % 500 === 0) {
          console.log("[SBC gemini-audio] chunk #", n, "playing through speakers");
        }
        queueGeminiAudio(b64);
      }
    }
    if (m.serverContent?.turnComplete) setExaminerSpeaking(false);
  }

  // Decode Gemini Live's base64 PCM audio and schedule it on the
  // playback context. Uses a monotonic nextTime marker so successive
  // chunks stitch seamlessly — critical because Gemini splits a single
  // spoken turn across dozens of ~50ms chunks and any drift audibly
  // stutters. Reset nextTime forward if we've fallen behind (e.g. the
  // context was suspended on tab-blur).
  function queueGeminiAudio(base64Data: string) {
    const ctx = playbackCtxRef.current;
    if (!ctx) return;
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // Interpret as signed 16-bit little-endian PCM.
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    if (float32.length === 0) return;
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    const startAt = Math.max(now, playbackNextTimeRef.current);
    src.start(startAt);
    playbackNextTimeRef.current = startAt + buffer.duration;
  }

  // Browser TTS for the opening prompt. Same pattern as the green TTS
  // buttons in Reading Aloud: en-GB voice, slightly slowed. Resolves
  // when the utterance finishes so start() can then open the mic
  // without the opener bleeding back into Gemini's input.
  function speakOpener(text: string, gender: "female" | "male" = "female"): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        resolve();
        return;
      }
      const synth = window.speechSynthesis;
      synth.cancel();
      let spoken = false;
      const speak = () => {
        // Race guard: both voiceschanged AND the 250ms fallback timer
        // can arrive within a browser's typical voice-load window,
        // and both call speak(). Without this flag we'd queue the
        // utterance twice, so the student hears the prompt read
        // out twice — which is EXACTLY the bug the SBC log surfaced
        // ("FIRING TTS #1" logged once but audio played twice).
        if (spoken) {
          console.log("[SBC opener] speak() re-entry blocked");
          return;
        }
        spoken = true;
        const utter = new SpeechSynthesisUtterance(text);
        const voices = synth.getVoices();
        // Voice picker priority:
        //   1. en-SG (Singapore English) — rare but ideal for PSLE
        //      context. Some Windows systems ship "Microsoft Wayan"
        //      (id-ID) which is close-ish; also try en-SG lang code.
        //   2. Named Singapore/SEA voices (Ivy, Wayan) as loose match.
        //   3. Strict British voices (Google UK, MS Susan/Hazel/Sonia,
        //      Apple Kate/Serena/Daniel) — closest widely-available
        //      accent to Singapore English.
        //   4. Any en-GB voice.
        //   5. Any en-* voice.
        // Also read voices explicitly with voiceURI markers since
        // browser vendors sometimes namespace SG voices oddly.
        const byName = (patterns: RegExp[]) =>
          patterns.map((p) => voices.find((v) => p.test(v.name) || p.test(v.voiceURI ?? ""))).find(Boolean);
        // Split voice preferences by gender. The malay avatar is male
        // (Mr Ismail); the other three are female. Google UK English
        // Male / Microsoft George|Ryan / Apple Daniel|Oliver are the
        // widely-shipped male en-GB voices.
        const genderPatterns = gender === "male"
          ? [
              /Google UK English Male/i,
              /Microsoft (George|Ryan).*United Kingdom/i,
              /^(Daniel|Oliver|Arthur|Reed|Rocko)$/i,
            ]
          : [
              /Google UK English Female/i,
              /Microsoft (Susan|Hazel|Sonia|Libby).*United Kingdom/i,
              /^(Kate|Serena|Martha|Fiona)$/i,
            ];
        const preferred =
          voices.find((v) => v.lang === "en-SG") ||
          byName([
            /Singapore/i,
            /\ben-SG\b/i,
            /Wayan/i,
          ]) ||
          byName(genderPatterns) ||
          byName([
            /\bUK\b.*English/i,
            /English.*\bUK\b/i,
          ]) ||
          voices.find((v) => v.lang === "en-GB") ||
          voices.find((v) => v.lang.startsWith("en-GB")) ||
          voices.find((v) => v.lang.startsWith("en"));
        if (preferred) {
          utter.voice = preferred;
          utter.lang = preferred.lang;
        } else {
          utter.lang = "en-GB";
        }
        utter.rate = 0.95;
        utter.onend = () => resolve();
        utter.onerror = () => resolve();
        synth.speak(utter);
      };
      // Voices are loaded async in some browsers. If empty, wait for
      // the voiceschanged event once, then speak.
      if (synth.getVoices().length === 0) {
        const onVoices = () => { synth.removeEventListener("voiceschanged", onVoices); speak(); };
        synth.addEventListener("voiceschanged", onVoices);
        // Belt-and-braces: some browsers fire the event late — kick after 250ms.
        setTimeout(speak, 250);
      } else {
        speak();
      }
    });
  }

  async function startMicStream(session: unknown) {
    // Access mic, wire audio chunks into session.sendRealtimeInput.
    // The @google/genai live session accepts 16kHz PCM chunks; we run a
    // Web Audio API worklet to downsample the mic stream.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Turn OFF the browser's built-in AGC/noise-suppression/echo-
        // cancellation processing. These aggressively gate near-
        // silence and can zero out soft speech from a child before it
        // reaches our script processor. Gemini's server-side VAD does
        // its own noise handling.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const audioContext = new AudioContext({ sampleRate: 16000 });
    // Some browsers suspend a freshly-created AudioContext until the
    // next user gesture — resume it explicitly so onaudioprocess fires.
    if (audioContext.state === "suspended") {
      await audioContext.resume().catch(() => { /* ignore */ });
    }
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioContext.destination);
    micStreamRef.current = stream;
    micCtxRef.current = audioContext;
    micProcessorRef.current = processor;
    console.log("[SBC mic] started", {
      sampleRate: audioContext.sampleRate,
      state: audioContext.state,
      tracks: stream.getAudioTracks().map((t) => ({ label: t.label, enabled: t.enabled, muted: t.muted })),
    });
    let chunkCounter = 0;
    let loudChunkCounter = 0;
    processor.onaudioprocess = (e) => {
      // Guard against send-after-close: onclose fires before the
      // processor tears down, so the last few audio slices would
      // otherwise hit the WebSocket after it's already CLOSING.
      if (!sessionAliveRef.current) return;
      const input = e.inputBuffer.getChannelData(0);
      // Compute chunk peak — if it's ~0 across many chunks we know the
      // mic isn't picking anything up (permissions revoked, wrong
      // device, muted at OS level, etc.). Log every ~2s of audio.
      let peak = 0;
      for (let i = 0; i < input.length; i++) {
        const v = Math.abs(input[i]);
        if (v > peak) peak = v;
      }
      if (peak > 0.02) loudChunkCounter++;
      chunkCounter++;
      if (chunkCounter % 8 === 0) {
        console.log("[SBC mic] chunk", chunkCounter, "peak", peak.toFixed(3), "loud", loudChunkCounter);
      }
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
      const s = session as { sendRealtimeInput: (arg: { media: { data: string; mimeType: string } }) => void };
      try {
        s.sendRealtimeInput({
          media: {
            data: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))),
            mimeType: "audio/pcm;rate=16000",
          },
        });
      } catch {
        // Session closed under us — flip the flag so we stop trying.
        sessionAliveRef.current = false;
      }
    };
  }

  function teardownMic() {
    const p = micProcessorRef.current;
    if (p) {
      try { p.onaudioprocess = null; p.disconnect(); } catch { /* ignore */ }
      micProcessorRef.current = null;
    }
    const ctx = micCtxRef.current;
    if (ctx && ctx.state !== "closed") {
      ctx.close().catch(() => { /* ignore */ });
    }
    micCtxRef.current = null;
    const s = micStreamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
    }
    micStreamRef.current = null;
  }

  async function endAndScore() {
    if (!passage) return;
    setStatus("ending");
    sessionAliveRef.current = false;
    teardownMic();
    const s = sessionRef.current as { close?: () => void } | null;
    if (s?.close) s.close();
    // Bail early if the student never spoke — the scoring endpoint
    // needs at least 2 turns. Show a friendly message instead of
    // leaking the raw "transcript array with at least 2 turns required"
    // response.
    const studentTurns = transcript.filter((t) => t.speaker === "student").length;
    if (studentTurns === 0) {
      setError("No student answer captured — did the mic pick up your voice? Click Try again and speak clearly after the examiner finishes the opening prompt.");
      setStatus("error");
      return;
    }
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
          {status === "error" && (
            <Card>
              <p className="text-rose-600 text-sm mb-2">{error}</p>
              <button
                onClick={() => { setError(null); setStatus("ready"); setTranscript([]); setScore(null); }}
                className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-slate-900"
              >
                Try again
              </button>
            </Card>
          )}

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
                  <p className="text-xs text-slate-700 leading-relaxed">Speak naturally — no need to pause or stop recording. The examiner listens continuously and will respond when you finish a thought. Aim for a 3-4 minute conversation. When you&apos;re done, click End &amp; Score.</p>
                  {status === "live" && !transcript.some((t) => t.speaker === "student") && (
                    <p className="text-[10px] text-emerald-600 font-semibold mt-1">🎤 Listening — start speaking whenever you&apos;re ready.</p>
                  )}
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
