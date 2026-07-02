"use client";

import { useRef, useState } from "react";

// Full published Gemini Live prebuilt voice roster. First 10 are the
// widely-documented "safe" list; the newer/less-documented ones after
// that are model-version dependent and may 1008-close the session
// (which we'll surface as a clear error). The point of a picker is
// that admins can try them all against the same sample line.
const VOICES = [
  // Widely documented (safe)
  "Kore", "Zephyr", "Aoede", "Leda", "Callirrhoe", "Autonoe",
  "Puck", "Charon", "Fenrir", "Orus",
  // Newer / preview
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam",
  "Despina", "Enceladus", "Erinome", "Gacrux", "Iapetus",
  "Laomedeia", "Pulcherrima", "Rasalgethi", "Sadachbia",
  "Sadaltager", "Schedar", "Sulafat", "Umbriel",
  "Vindemiatrix", "Zubenelgenubi",
];

const DEFAULT_SAMPLE = "Hello! Let's have a chat about this picture. Would you be willing to join a long queue for something? Why or why not?";

// Voices we've already picked for personas — flag them in the UI so
// the admin can see the current assignment without leaving the page.
const IN_USE: Record<string, string> = {
  Zephyr: "Ms Tan",
  Aoede: "Ms Lim",
  Leda: "Mrs Kumar",
  Puck: "Mr Ismail",
};

type PlayState = "idle" | "connecting" | "playing" | "done" | "error";

export function OralVoiceTester() {
  const [selectedVoice, setSelectedVoice] = useState<string>("Kore");
  const [sampleText, setSampleText] = useState<string>(DEFAULT_SAMPLE);
  const [playState, setPlayState] = useState<PlayState>("idle");
  const [error, setError] = useState<string | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackNextTimeRef = useRef<number>(0);
  const sessionRef = useRef<unknown>(null);

  async function playSample() {
    setError(null);
    setPlayState("connecting");
    try {
      // Fresh playback context per sample so the nextTime cursor
      // starts at 0 and successive samples don't queue on top of
      // each other from a previous run.
      const prev = playbackCtxRef.current;
      if (prev && prev.state !== "closed") await prev.close().catch(() => {});
      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
      playbackNextTimeRef.current = 0;

      const tokenResp = await fetch("/api/oral-coach/voice-sample-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceName: selectedVoice, sampleText }),
      });
      if (!tokenResp.ok) {
        const raw = await tokenResp.text();
        throw new Error(`Token mint failed: ${raw}`);
      }
      const { token, model } = await tokenResp.json();

      const mod = await import("@google/genai");
      const client = new mod.GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
      const session = await client.live.connect({
        model,
        config: {
          responseModalities: [mod.Modality.AUDIO],
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => setPlayState("playing"),
          onmessage: (msg: unknown) => handleMessage(msg),
          onerror: (e: unknown) => {
            setError(String(e));
            setPlayState("error");
          },
          onclose: (ev: unknown) => {
            const c = ev as { code?: number; reason?: string };
            if (c?.reason && c.code !== 1000) {
              setError(`Live closed: ${c.reason}`);
              setPlayState("error");
            } else {
              setPlayState((s) => (s === "playing" || s === "connecting" ? "done" : s));
            }
          },
        },
      });
      sessionRef.current = session;

      // Trigger the "read this sentence" behaviour by sending a
      // minimal user turn. The system instruction forces Gemini to
      // reply with the sample text verbatim.
      const s = session as { sendClientContent: (arg: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }) => void };
      s.sendClientContent({
        turns: [{ role: "user", parts: [{ text: "Please read the sample." }] }],
        turnComplete: true,
      });

      // Auto-close after 20s so users don't accumulate open sessions
      // if a voice hangs or produces no output.
      setTimeout(() => {
        const sr = sessionRef.current as { close?: () => void } | null;
        if (sr?.close) sr.close();
      }, 20000);
    } catch (e) {
      setError((e as Error).message);
      setPlayState("error");
    }
  }

  function handleMessage(msg: unknown) {
    const m = msg as {
      serverContent?: {
        modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
        turnComplete?: boolean;
      };
    };
    const parts = m.serverContent?.modelTurn?.parts ?? [];
    for (const part of parts) {
      const b64 = part.inlineData?.data;
      if (b64) queueAudio(b64);
    }
    if (m.serverContent?.turnComplete) {
      const sr = sessionRef.current as { close?: () => void } | null;
      // Close the session after the sample finishes to release the
      // ephemeral token slot.
      setTimeout(() => { if (sr?.close) sr.close(); }, 500);
    }
  }

  function queueAudio(base64Data: string) {
    const ctx = playbackCtxRef.current;
    if (!ctx) return;
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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

  const busy = playState === "connecting" || playState === "playing";

  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Voice tester</p>
        <p className="text-[10px] text-slate-400">Pick a voice, edit the sample if you like, click Play.</p>
      </div>
      <div className="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 gap-1 mb-2">
        {VOICES.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setSelectedVoice(v)}
            className={`text-[10px] px-1.5 py-1 rounded-md border transition truncate ${
              v === selectedVoice
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-white text-slate-700 border-slate-200 hover:border-indigo-300"
            }`}
            title={IN_USE[v] ? `Currently used by ${IN_USE[v]}` : undefined}
          >
            {v}
            {IN_USE[v] && <span className="ml-0.5 text-[8px] opacity-70">•</span>}
          </button>
        ))}
      </div>
      <textarea
        value={sampleText}
        onChange={(e) => setSampleText(e.target.value)}
        rows={2}
        className="w-full text-xs border border-slate-200 rounded-md px-2 py-1.5 resize-none focus:outline-none focus:border-indigo-400"
        placeholder="Sample sentence for the voice to read"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          disabled={busy}
          onClick={playSample}
          className={`text-xs px-3 py-1.5 rounded-lg font-semibold ${
            busy ? "bg-slate-200 text-slate-500" : "bg-emerald-600 text-white hover:bg-emerald-700"
          }`}
        >
          {playState === "connecting" ? "Connecting…" : playState === "playing" ? "Playing…" : `▶ Play ${selectedVoice}`}
        </button>
        {IN_USE[selectedVoice] && (
          <span className="text-[10px] text-slate-500">Currently used by <b>{IN_USE[selectedVoice]}</b></span>
        )}
        {playState === "done" && <span className="text-[10px] text-emerald-600">Done</span>}
        {playState === "error" && error && (
          <span className="text-[10px] text-rose-600 truncate max-w-md" title={error}>Error: {error}</span>
        )}
      </div>
    </div>
  );
}
