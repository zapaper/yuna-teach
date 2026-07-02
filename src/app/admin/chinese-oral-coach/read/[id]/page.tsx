"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { ExaminerAvatar } from "@/components/ExaminerAvatar";
import { getOralThemeZh } from "@/lib/oral-themes-zh";
import { loadOralSession, updateOralSession, pickRandomSbcDay } from "@/lib/oral-session";

// 华文朗读 · Reading Aloud practice — MVP version.
//
// Uses Azure Speech SDK's pronunciation assessment in zh-CN mode.
// Scores /20 across four dimensions per the industry-consensus PSLE
// rubric (SEAB doesn't publish sub-marks):
//   发音与声调    ≈ 6 marks  (accuracy score, tones baked in)
//   流利度        ≈ 5 marks  (fluency score)
//   语调/表情达意 ≈ 5 marks  (prosody score, if returned)
//   准确度        ≈ 4 marks  (completeness score, missing/extra chars)
//
// MVP scope: skips the per-character highlighting the English module
// does. Chinese pronunciation assessment returns per-character +
// per-tone data — future iteration will surface which tones the
// student slipped on.

export default function ChineseReadAloudPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

type AzureWord = {
  Word?: string;
  PronunciationAssessment?: {
    AccuracyScore?: number;
    ErrorType?: string;
  };
};

type ScoreSummary = {
  accuracy: number;
  fluency: number;
  completeness: number;
  prosody: number | null;
  words: AzureWord[];
  transcription: string;
  seab: {
    // Percent per dimension, 0-100 in 5% increments.
    pronunciationPercent: number;    // 发音与声调
    fluencyPercent: number;          // 流利度
    expressivenessPercent: number;   // 语调 / 表情达意
    accuracyPercent: number;         // 准确度
    // Overall = equal-weighted average of the 4 dimensions.
    overallPercent: number;
    total: number;                   // /20 = overallPercent × 20 / 100
  };
};

function Inner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = String(params.id);
  const userId = searchParams.get("userId") ?? "";
  const isFlow = searchParams.get("flow") === "1";

  const theme = getOralThemeZh(id);

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<"idle" | "ready" | "recording" | "scoring" | "done" | "error">("ready");
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState<ScoreSummary | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const recognizerRef = useRef<unknown>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then((r) => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  async function start() {
    if (!theme) return;
    setError(null);
    setScore(null);
    setRecordingUrl(null);
    audioChunksRef.current = [];
    setStatus("recording");

    try {
      const tokenResp = await fetch("/api/oral-coach/azure-token", { method: "POST" });
      if (!tokenResp.ok) throw new Error("Failed to mint Azure token");
      const { token, region } = await tokenResp.json();

      const sdk = await import("microsoft-cognitiveservices-speech-sdk");
      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token, region);
      speechConfig.speechRecognitionLanguage = "zh-CN";
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "10000",
      );
      speechConfig.setProperty(
        sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, "5000",
      );

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // Parallel MediaRecorder for playback of the student's read.
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        setRecordingUrl(URL.createObjectURL(blob));
      };
      mr.start(200);

      const audioConfig = sdk.AudioConfig.fromMicrophoneInput();
      const pronConfig = new sdk.PronunciationAssessmentConfig(
        theme.passage,
        sdk.PronunciationAssessmentGradingSystem.HundredMark,
        sdk.PronunciationAssessmentGranularity.Phoneme,
        true, // enableMiscue
      );
      pronConfig.enableProsodyAssessment = true;
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      pronConfig.applyTo(recognizer);
      recognizerRef.current = recognizer;

      const collected = {
        accuracy: [] as number[],
        fluency: [] as number[],
        completeness: [] as number[],
        prosody: [] as number[],
        words: [] as AzureWord[],
        transcription: "" as string,
      };

      recognizer.recognized = (_s: unknown, e: { result: { text?: string; properties: { getProperty: (id: unknown) => string }; json?: string } }) => {
        try {
          const jsonRaw = e.result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult);
          const parsed = JSON.parse(jsonRaw) as {
            NBest?: Array<{
              PronunciationAssessment?: {
                AccuracyScore?: number;
                FluencyScore?: number;
                CompletenessScore?: number;
                ProsodyScore?: number;
              };
              Words?: AzureWord[];
            }>;
            DisplayText?: string;
          };
          const nBest = parsed.NBest?.[0];
          if (nBest?.PronunciationAssessment) {
            const a = nBest.PronunciationAssessment.AccuracyScore;
            const f = nBest.PronunciationAssessment.FluencyScore;
            const c = nBest.PronunciationAssessment.CompletenessScore;
            const p = nBest.PronunciationAssessment.ProsodyScore;
            if (typeof a === "number") collected.accuracy.push(a);
            if (typeof f === "number") collected.fluency.push(f);
            if (typeof c === "number") collected.completeness.push(c);
            if (typeof p === "number") collected.prosody.push(p);
          }
          if (Array.isArray(nBest?.Words)) collected.words.push(...nBest!.Words!);
          if (parsed.DisplayText) collected.transcription += (collected.transcription ? " " : "") + parsed.DisplayText;
        } catch {
          // ignore malformed responses
        }
      };

      recognizer.sessionStopped = () => {
        const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        const acc = avg(collected.accuracy);
        const flu = avg(collected.fluency);
        const comp = avg(collected.completeness);
        const prosody = collected.prosody.length ? avg(collected.prosody) : null;

        setScore({
          accuracy: acc,
          fluency: flu,
          completeness: comp,
          prosody,
          words: collected.words,
          transcription: collected.transcription,
          seab: computeSeabScoreZh(acc, flu, prosody, comp),
        });
        setStatus("done");
        recognizer.close();
        if (mr.state !== "inactive") mr.stop();
        stream.getTracks().forEach((t) => t.stop());
        mediaRecorderRef.current = null;
        micStreamRef.current = null;
      };

      recognizer.startContinuousRecognitionAsync(
        () => { /* started */ },
        (err: string) => { setError(err); setStatus("error"); },
      );
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }

  function stop() {
    setStatus("scoring");
    const rec = recognizerRef.current as { stopContinuousRecognitionAsync?: (cb: () => void) => void } | null;
    rec?.stopContinuousRecognitionAsync?.(() => { /* handled in sessionStopped */ });
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
          <h1 className="text-lg font-bold text-slate-800">朗读 · Reading Aloud</h1>
          <span className="text-xs text-slate-500 hidden sm:inline">主题:{theme.theme}</span>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-4 space-y-3">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-start gap-3">
            <ExaminerAvatar speaking={status === "recording"} className="w-24 h-24 rounded-xl bg-slate-100 flex-shrink-0 ring-2 ring-white shadow" />
            <div className="flex-1">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">请朗读以下短文</p>
              <p className="text-slate-900 leading-relaxed text-base" style={{ lineHeight: "2.1", letterSpacing: "0.02em" }}>{theme.passage}</p>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 flex-wrap">
            {status === "ready" && (
              <button onClick={start} className="text-sm bg-emerald-600 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-emerald-700">
                🎤 开始朗读
              </button>
            )}
            {status === "recording" && (
              <button onClick={stop} className="text-sm bg-rose-600 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-rose-700 animate-pulse">
                ■ 停止录音
              </button>
            )}
            {status === "scoring" && <span className="text-sm text-slate-500">正在评分…</span>}
            {status === "error" && <span className="text-sm text-rose-600">Error: {error}</span>}
            {status === "done" && (
              <button onClick={() => { setStatus("ready"); setScore(null); }} className="text-sm bg-slate-100 text-slate-700 px-4 py-2 rounded-lg font-semibold hover:bg-slate-200">
                重试
              </button>
            )}
          </div>

          {score && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3">
              <div>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h2 className="text-sm font-bold text-slate-800">朗读评分</h2>
                  {recordingUrl && (
                    /* eslint-disable-next-line jsx-a11y/media-has-caption */
                    <audio controls src={recordingUrl} preload="auto" className="h-8" style={{ minWidth: 220 }} />
                  )}
                </div>
                <div className="rounded-xl bg-gradient-to-br from-slate-50 to-white border border-slate-200 p-3">
                  <div className="flex items-end gap-2">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold pb-1">总分 · Total</p>
                    <span className="text-3xl font-bold text-slate-800 leading-none">{score.seab.total}</span>
                    <span className="text-sm text-slate-500 pb-0.5">/ 20 · {score.seab.overallPercent}%</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                    <SeabDim label="发音与声调" percent={score.seab.pronunciationPercent} tone="indigo" />
                    <SeabDim label="流利度" percent={score.seab.fluencyPercent} tone="purple" />
                    <SeabDim label="语调" percent={score.seab.expressivenessPercent} tone="amber" />
                    <SeabDim label="准确度" percent={score.seab.accuracyPercent} tone="rose" />
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">识别出来的朗读</p>
                <p className="text-sm text-slate-700 leading-relaxed">{score.transcription || "(未识别出内容)"}</p>
              </div>

              {isFlow && (
                <ContinueToSbcButton themeId={id} userId={userId} score={score} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Per-dimension percentage → equal-weighted average → /20.
// Snap each dimension to the nearest 5% so it matches the SBC style.
function computeSeabScoreZh(
  accuracy: number,
  fluency: number,
  prosody: number | null,
  completeness: number,
) {
  const snap5 = (n: number) => Math.round(n / 5) * 5;
  const clamp = (n: number) => Math.max(0, Math.min(100, snap5(n)));

  const pronunciationPercent = clamp(accuracy);
  const fluencyPercent = clamp(fluency);
  // Prosody in Chinese reads conservatively; +15pp calibration.
  // Fall back to fluency if the engine didn't return prosody.
  const expressivenessPercent = clamp((prosody ?? fluency) + 15);
  const accuracyPercent = clamp(completeness);

  const overallPercent = snap5(
    (pronunciationPercent + fluencyPercent + expressivenessPercent + accuracyPercent) / 4,
  );
  const total = Math.round((overallPercent * 20 / 100) * 100) / 100;

  return {
    pronunciationPercent,
    fluencyPercent,
    expressivenessPercent,
    accuracyPercent,
    overallPercent,
    total,
  };
}

function SeabDim({ label, percent, tone }: { label: string; percent: number; tone: "indigo" | "purple" | "amber" | "rose" }) {
  const c = TONE[tone];
  return (
    <div className={`rounded-lg ${c.bg} border ${c.border} px-2 py-1.5`}>
      <p className={`text-[10px] uppercase tracking-wide ${c.label} font-semibold`}>{label}</p>
      <p className={`text-lg font-bold leading-none ${c.text}`}>
        {percent}<span className="text-[10px] text-slate-500 ml-0.5">%</span>
      </p>
    </div>
  );
}

const TONE = {
  indigo: { bg: "bg-indigo-50",  border: "border-indigo-200",  label: "text-indigo-700",  text: "text-indigo-800"  },
  purple: { bg: "bg-purple-50",  border: "border-purple-200",  label: "text-purple-700",  text: "text-purple-800"  },
  amber:  { bg: "bg-amber-50",   border: "border-amber-200",   label: "text-amber-700",   text: "text-amber-800"   },
  rose:   { bg: "bg-rose-50",    border: "border-rose-200",    label: "text-rose-700",    text: "text-rose-800"    },
};

function ContinueToSbcButton({ themeId, userId, score }: { themeId: string; userId: string; score: ScoreSummary }) {
  const handleClick = () => {
    const tips: string[] = [];
    const s = score.seab;
    if (s.pronunciationPercent < 70) tips.push("发音与声调要更准确 —— 特别是二三声,以及「得/的/地」。");
    if (s.fluencyPercent < 70) tips.push("按词语分组来读,不要一字一字地念;停顿要落在标点上。");
    if (s.expressivenessPercent < 70) tips.push("多用语气表达感情:问号上扬,句号下降,重点词要加强。");
    if (s.accuracyPercent < 70) tips.push("看清每一个字,不要漏字、加字或换字。");
    if (tips.length === 0) tips.push("朗读稳健 —— 保持这样的状态进入会话环节。");

    const existing = loadOralSession();
    if (!existing) updateOralSession({});
    updateOralSession({
      reading: {
        year: themeId,
        day: 0,
        pronunciation: s.pronunciationPercent * 6 / 100,
        fluencyRhythm: s.fluencyPercent * 5 / 100,
        expressiveness: s.expressivenessPercent * 5 / 100,
        total: s.total,
        topTips: tips.slice(0, 3),
      },
    });

    // For Chinese, SBC uses a randomly-selected DIFFERENT theme from
    // the same pool so the picture the student sees is unexpected.
    // pickRandomSbcDay() returns 1 or 2; here we use it to pick a
    // random theme index within the Chinese catalogue.
    void pickRandomSbcDay;
    // For MVP: SBC stays on the SAME theme so the picture + prompts
    // match the passage. We can shuffle in a later iteration if the
    // user asks — the English module randomises across the year's
    // two days, but Chinese has only one theme per topic.
    window.location.href = `/admin/chinese-oral-coach/sbc/${themeId}?userId=${userId}&flow=1`;
  };
  return (
    <div className="rounded-xl bg-gradient-to-br from-emerald-50 to-emerald-100 border border-emerald-200 p-4 flex items-center justify-between gap-4 flex-wrap">
      <div>
        <p className="text-sm font-semibold text-emerald-800">准备好进入会话环节了吗?</p>
        <p className="text-xs text-emerald-700/80 mt-0.5">考官会问三道题目 —— 描述、意见、经历。会话占 30 分,合起来是 50 分。</p>
      </div>
      <button
        type="button"
        onClick={handleClick}
        className="text-base bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold shadow-md hover:bg-emerald-700 hover:shadow-lg transition flex-shrink-0"
      >
        进入会话 · Continue →
      </button>
    </div>
  );
}

function FullPageSpinner() {
  return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
}
function FullPageDenied() {
  return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
}
