"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { ExaminerAvatar } from "@/components/ExaminerAvatar";
import { getOralAvatar, getOralAvatarKey } from "@/lib/oral-avatar";
import { getOralThemeZh } from "@/lib/oral-themes-zh";
import { updateOralSession } from "@/lib/oral-session";

// 华文会话 · Chinese Stimulus-Based Conversation.
//
// Same architecture as /admin/english-oral-coach/sbc/[year]/[day]:
// browser TTS speaks Q1 (描述) in Mandarin, Gemini Live handles Q2
// and Q3 verbatim, we transcribe both directions and post to
// /api/chinese-oral-coach/sbc-score at End & Score.

export default function ChineseSbcPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

type TranscriptTurn = { speaker: "examiner" | "student"; text: string; ts: number };
type DimTip = { label: string; hint: string; examples: string[] };
type DimBlock = {
  scorePercent: number;
  verdict: string;
  seabLooksFor: string;
  details: string[];
  tips: DimTip[];
  modelUpgrade: string;
};
type SbcScore = {
  overallSeabScore: number;   // /30
  overallPercent: number;
  overallVerdict: string;
  describe: DimBlock;
  opinion: DimBlock;
  experience: DimBlock;
};

function Inner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const themeId = String(params.id);
  const userId = searchParams.get("userId") ?? "";
  const isFlow = searchParams.get("flow") === "1";

  const theme = getOralThemeZh(themeId);

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<"ready" | "connecting" | "live" | "ending" | "scoring" | "done" | "error">("ready");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [examinerSpeaking, setExaminerSpeaking] = useState(false);
  const [score, setScore] = useState<SbcScore | null>(null);
  const sessionRef = useRef<unknown>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackNextTimeRef = useRef<number>(0);
  const studentHasSpokenRef = useRef<boolean>(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionAliveRef = useRef<boolean>(false);
  const geminiSpeakingRef = useRef<boolean>(false);
  const geminiSpeakingCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then((r) => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  const imgSrc = theme ? `/api/chinese-oral-coach/stimulus/${themeId}` : "";

  async function start() {
    if (!theme) return;
    setError(null);
    setScore(null);
    setTranscript([]);
    studentHasSpokenRef.current = false;
    setStatus("connecting");
    try {
      const chosenAvatar = getOralAvatar(getOralAvatarKey());
      const tokenResp = await fetch("/api/chinese-oral-coach/gemini-live-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          themeId,
          gender: chosenAvatar.gender,
          geminiVoice: chosenAvatar.geminiVoice,
        }),
      });
      if (!tokenResp.ok) {
        const msg = await tokenResp.text();
        throw new Error(`获取会话令牌失败:${msg}`);
      }
      const { token, model, voiceName, openerPrompt } = await tokenResp.json();

      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
      playbackNextTimeRef.current = 0;

      // Chinese TTS opener — speak Q1 (描述) so Gemini can react to
      // the student's answer without repeating the question.
      const opener = `你好!我们一起来看看这幅图。${openerPrompt}`;
      setTranscript([{ speaker: "examiner", text: opener, ts: Date.now() }]);
      setExaminerSpeaking(true);
      setStatus("live");
      await speakOpenerZh(opener);
      setExaminerSpeaking(false);

      const mod = await import("@google/genai");
      const client = new mod.GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
      const session = await client.live.connect({
        model,
        config: {
          responseModalities: [mod.Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName ?? "Callirrhoe" } },
          },
        },
        callbacks: {
          onopen: () => { sessionAliveRef.current = true; },
          onmessage: (msg: unknown) => handleLiveMessage(msg),
          onerror: (e: unknown) => {
            sessionAliveRef.current = false;
            teardownMic();
            setError(String(e));
            setStatus("error");
          },
          onclose: (ev: unknown) => {
            const c = ev as { code?: number; reason?: string };
            sessionAliveRef.current = false;
            teardownMic();
            if (c?.reason && c.code !== 1000) {
              setError(`会话中断:${c.reason}`);
              setStatus("error");
            } else if (status === "live") {
              setStatus("ending");
            }
          },
        },
      });
      sessionRef.current = session;

      await startMicStream(session);
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }

  function handleLiveMessage(msg: unknown) {
    const m = msg as {
      serverContent?: {
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
        turnComplete?: boolean;
      };
    };
    const inText = m.serverContent?.inputTranscription?.text;
    const outText = m.serverContent?.outputTranscription?.text;
    if (inText) {
      studentHasSpokenRef.current = true;
      setTranscript((prev) => appendOrExtend(prev, "student", inText));
    }
    if (!studentHasSpokenRef.current) {
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
        geminiSpeakingRef.current = true;
        if (geminiSpeakingCooldownRef.current) clearTimeout(geminiSpeakingCooldownRef.current);
        geminiSpeakingCooldownRef.current = setTimeout(() => {
          geminiSpeakingRef.current = false;
        }, 400);
        queueGeminiAudio(b64);
      }
    }
    if (m.serverContent?.turnComplete) setExaminerSpeaking(false);
  }

  function queueGeminiAudio(base64Data: string) {
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

  async function startMicStream(session: unknown) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    const audioContext = new AudioContext({ sampleRate: 16000 });
    if (audioContext.state === "suspended") await audioContext.resume().catch(() => {});
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioContext.destination);
    micStreamRef.current = stream;
    micCtxRef.current = audioContext;
    micProcessorRef.current = processor;
    processor.onaudioprocess = (e) => {
      if (!sessionAliveRef.current) return;
      const pctx = playbackCtxRef.current;
      if (pctx && pctx.currentTime < playbackNextTimeRef.current + 0.4) return;
      if (geminiSpeakingRef.current) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
      const s = session as { sendRealtimeInput: (arg: { audio: { data: string; mimeType: string } }) => void };
      try {
        s.sendRealtimeInput({
          audio: {
            data: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))),
            mimeType: "audio/pcm;rate=16000",
          },
        });
      } catch {
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
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    micCtxRef.current = null;
    const s = micStreamRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
  }

  async function endAndScore() {
    if (!theme) return;
    setStatus("ending");
    sessionAliveRef.current = false;
    teardownMic();
    const s = sessionRef.current as { close?: () => void } | null;
    if (s?.close) s.close();
    const studentTurns = transcript.filter((t) => t.speaker === "student").length;
    if (studentTurns === 0) {
      setError("没有捕捉到学生的回答 —— 请重新尝试。");
      setStatus("error");
      return;
    }
    setStatus("scoring");
    try {
      const resp = await fetch("/api/chinese-oral-coach/sbc-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          theme: theme.theme,
          blurb: theme.blurb,
          prompts: [theme.prompts.describe, theme.prompts.opinion, theme.prompts.experience],
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data: SbcScore = await resp.json();
      setScore(data);
      setStatus("done");
      if (isFlow) {
        const topTips: string[] = [];
        [
          { label: "描述", block: data.describe },
          { label: "意见", block: data.opinion },
          { label: "经历", block: data.experience },
        ].forEach(({ label, block }) => {
          if (block.scorePercent < 100 && block.tips?.length > 0) {
            topTips.push(`${label}:${block.tips[0].hint}`);
          }
        });
        updateOralSession({
          sbc: {
            year: themeId,
            day: 0,
            overallSeabScore: data.overallSeabScore,
            overallPercent: data.overallPercent,
            overallVerdict: data.overallVerdict,
            q1Percent: data.describe.scorePercent,
            q2Percent: data.opinion.scorePercent,
            q3Percent: data.experience.scorePercent,
            topTips: topTips.slice(0, 3),
          },
        });
        setTimeout(() => {
          window.location.href = `/admin/chinese-oral-coach/results?userId=${userId}`;
        }, 600);
      }
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }

  if (allowed === null) return <FullPageSpinner />;
  if (!allowed) return <FullPageDenied />;
  if (!theme) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <p className="text-slate-500 text-sm">Theme not found.</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <Link href={`/admin/chinese-oral-coach?userId=${userId}`} className="text-slate-400 hover:text-slate-600 text-xs">← 主页</Link>
          <h1 className="text-lg font-bold text-slate-800">会话 · Stimulus-Based Conversation</h1>
          <span className="text-xs text-slate-500 hidden sm:inline">主题:{theme.theme}</span>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-3 space-y-2">
          {status === "error" && (
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
              <p className="text-rose-600 text-sm mb-2">{error}</p>
              <button
                onClick={() => { setError(null); setStatus("ready"); setTranscript([]); setScore(null); }}
                className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-slate-900"
              >
                重试
              </button>
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3 flex items-center gap-3">
            <ExaminerAvatar
              speaking={examinerSpeaking}
              className="w-32 h-32 rounded-xl bg-slate-100 flex-shrink-0 ring-2 ring-white shadow"
            />
            <div className="flex-1">
              <p className="text-xs text-slate-700 leading-relaxed">自然地说 —— 考官会耐心听你说完再回应。目标是 3-4 分钟的对话。说完最后一题后点「结束并评分」。</p>
              {status === "live" && !transcript.some((t) => t.speaker === "student") && (
                <p className="text-[10px] text-emerald-600 font-semibold mt-1">🎤 正在聆听 —— 请开始说话。</p>
              )}
            </div>
            {status === "ready" && (
              <button onClick={start} className="bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700">
                开始会话
              </button>
            )}
            {(status === "connecting" || status === "live") && (
              <button onClick={endAndScore} className="bg-rose-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold">
                结束并评分
              </button>
            )}
            {status === "scoring" && <span className="text-sm text-slate-500">正在评分…</span>}
            {status === "done" && !isFlow && (
              <Link href={`/admin/chinese-oral-coach?userId=${userId}`} className="bg-slate-800 text-white px-5 py-2.5 rounded-xl text-sm font-semibold">
                完成
              </Link>
            )}
          </div>

          {imgSrc && (
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgSrc}
                alt={theme.theme}
                className="w-full max-h-[400px] object-contain rounded-lg bg-slate-50"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
          )}

          {transcript.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3">
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-2">对话记录</p>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {transcript.map((t, i) => (
                  <div key={i} className={`flex ${t.speaker === "student" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] rounded-xl px-2.5 py-1.5 text-sm ${t.speaker === "student" ? "bg-indigo-50 text-indigo-900" : "bg-emerald-50 text-emerald-900"}`}>
                      <p className="text-[9px] uppercase tracking-wide opacity-60 mb-0.5">{t.speaker === "student" ? "学生" : "考官"}</p>
                      <p>{t.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {score && !isFlow && (
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500 font-semibold">会话评分</p>
              <div className="flex items-end gap-2 mt-1">
                <span className="text-3xl font-bold text-slate-800">{score.overallSeabScore}</span>
                <span className="text-sm text-slate-500 pb-0.5">/ 30 · {score.overallPercent}%</span>
              </div>
              <p className="text-xs text-slate-600 mt-2 leading-snug">{score.overallVerdict}</p>
              <div className="grid grid-cols-3 gap-2 mt-3">
                <ScoreCell label="描述 Q1" percent={score.describe.scorePercent} tone="blue" />
                <ScoreCell label="意见 Q2" percent={score.opinion.scorePercent} tone="purple" />
                <ScoreCell label="经历 Q3" percent={score.experience.scorePercent} tone="amber" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScoreCell({ label, percent, tone }: { label: string; percent: number; tone: "blue" | "purple" | "amber" }) {
  const c = tone === "blue" ? "bg-blue-50 text-blue-800 border-blue-200"
    : tone === "purple" ? "bg-purple-50 text-purple-800 border-purple-200"
    : "bg-amber-50 text-amber-800 border-amber-200";
  return (
    <div className={`rounded-lg border ${c} px-2 py-1.5`}>
      <p className="text-[10px] uppercase tracking-wide font-semibold opacity-80">{label}</p>
      <p className="text-lg font-bold">{percent}<span className="text-xs opacity-60 ml-0.5">%</span></p>
    </div>
  );
}

function appendOrExtend(prev: TranscriptTurn[], speaker: "examiner" | "student", text: string): TranscriptTurn[] {
  const last = prev[prev.length - 1];
  if (last && last.speaker === speaker && Date.now() - last.ts < 8000) {
    return [...prev.slice(0, -1), { ...last, text: (last.text + " " + text).trim() }];
  }
  return [...prev, { speaker, text, ts: Date.now() }];
}

// Chinese-flavoured TTS opener. Prefer zh-CN voices; fall back to
// browser default English voice if none available (rare on modern
// Windows/macOS but common on iOS).
function speakOpenerZh(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) { resolve(); return; }
    const synth = window.speechSynthesis;
    synth.cancel();
    let spoken = false;
    const speak = () => {
      if (spoken) return;
      spoken = true;
      const utter = new SpeechSynthesisUtterance(text);
      const voices = synth.getVoices();
      const byName = (patterns: RegExp[]) =>
        patterns.map((p) => voices.find((v) => p.test(v.name) || p.test(v.voiceURI ?? ""))).find(Boolean);
      const preferred =
        voices.find((v) => v.lang === "zh-CN") ||
        voices.find((v) => v.lang.startsWith("zh-CN")) ||
        byName([
          /Microsoft Xiaoxiao/i,
          /Microsoft Yaoyao/i,
          /Google 普通话/i,
          /Google 中国的|Chinese \(Mandarin/i,
          /^(Tingting|Meijia|Sinji)$/i,
        ]) ||
        voices.find((v) => v.lang.startsWith("zh"));
      if (preferred) { utter.voice = preferred; utter.lang = preferred.lang; }
      else utter.lang = "zh-CN";
      utter.rate = 0.9;
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      synth.speak(utter);
    };
    if (synth.getVoices().length === 0) {
      const onVoices = () => { synth.removeEventListener("voiceschanged", onVoices); speak(); };
      synth.addEventListener("voiceschanged", onVoices);
      setTimeout(speak, 250);
    } else {
      speak();
    }
  });
}

function FullPageSpinner() {
  return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
}
function FullPageDenied() {
  return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
}
