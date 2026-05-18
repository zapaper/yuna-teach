"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import type { MasterClassContent, MasterClassSlide } from "@/data/master-class";

export default function Page() {
  return (
    <Suspense>
      <MasterClassWorkshop />
    </Suspense>
  );
}

type PracticeQuestion = {
  id: string;
  questionNum: string;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  answer: string | null;
  marksAvailable: number | null;
  examPaper: { title: string; year: string | null };
};

type ApiPayload = {
  content: MasterClassContent;
  practice: {
    mcq: PracticeQuestion[];
    oeq: PracticeQuestion[];
    poolSize: number;
    mcqPool: number;
    oeqPool: number;
  };
};

function MasterClassWorkshop() {
  const slug = (useParams() as { slug?: string }).slug ?? "";
  const userId = useSearchParams().get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [data, setData] = useState<ApiPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Concept and mistake decks track current slide index independently.
  const [conceptIdx, setConceptIdx] = useState(0);
  const [mistakeIdx, setMistakeIdx] = useState(0);
  // IDs of questions already shown so "More practice" can exclude them
  // and we don't repeat. Reset on initial load.
  const [seenIds, setSeenIds] = useState<string[]>([]);
  const [moreLoading, setMoreLoading] = useState(false);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  useEffect(() => {
    if (allowed !== true || !slug) return;
    setLoading(true);
    fetch(`/api/admin/master-class/${slug}`)
      .then(async r => {
        if (!r.ok) {
          const d = await r.json();
          throw new Error(d.error ?? "Failed to load");
        }
        return r.json();
      })
      .then((d: ApiPayload) => {
        setData(d);
        const ids = [...d.practice.mcq, ...d.practice.oeq].map(q => q.id);
        setSeenIds(ids);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [allowed, slug]);

  async function loadMorePractice() {
    if (!slug) return;
    setMoreLoading(true);
    try {
      const exclude = seenIds.join(",");
      const res = await fetch(`/api/admin/master-class/${slug}?excludeIds=${encodeURIComponent(exclude)}`);
      const d: ApiPayload = await res.json();
      if (!res.ok) return;
      setData(prev => {
        if (!prev) return d;
        return {
          ...prev,
          practice: {
            ...prev.practice,
            mcq: [...prev.practice.mcq, ...d.practice.mcq],
            oeq: [...prev.practice.oeq, ...d.practice.oeq],
          },
        };
      });
      const newIds = [...d.practice.mcq, ...d.practice.oeq].map(q => q.id);
      setSeenIds(prev => [...prev, ...newIds]);
    } finally {
      setMoreLoading(false);
    }
  }

  if (allowed === null || loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }
  if (error || !data) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">{error ?? "Could not load Master Class."}</p></div>;
  }

  const { content, practice } = data;
  const stats = content.stats;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        {/* Header */}
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-baseline justify-between">
          <div>
            <Link href={`/admin/master-class?userId=${userId}`} className="text-xs text-slate-400 hover:text-slate-600">← All Master Classes</Link>
            <h1 className="text-lg font-bold text-slate-800 mt-1">{content.title}</h1>
            <p className="text-xs text-slate-400">{content.subject} · {content.level} · syllabus topic: <code className="bg-slate-100 px-1.5 py-0.5 rounded">{content.topicLabel}</code></p>
          </div>
        </div>

        <div className="max-w-4xl mx-auto px-4 py-6 space-y-8">

          {/* ── Glaring stats ── */}
          <section className="bg-gradient-to-br from-emerald-50 to-sky-50 border border-emerald-100 rounded-2xl p-6">
            <p className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider mb-2">Headline statistic</p>
            <p className="text-xl lg:text-2xl font-bold text-slate-900 leading-snug">{stats.headline}</p>
            <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat label="PSLE questions" value={String(stats.psleQuestions)} />
              <Stat label="% of PSLE Life-Science" value={`${stats.psleSubjectPercent}%`} />
              <Stat label="Practice pool" value={String(stats.totalPracticePool)} sub={`${stats.psleQuestionsInPool} PSLE + ${stats.schoolQuestionsInPool} school`} />
              <Stat label="OEQ proportion" value={`${stats.pctOeq}%`} sub="open-ended" />
            </div>
          </section>

          {/* ── Key words ── */}
          <section className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">Must-know words</p>
            <div className="flex flex-wrap gap-2">
              {content.keyWords.map(kw => (
                <span key={kw.word} title={kw.definition} className="bg-emerald-50 text-emerald-800 text-xs font-semibold px-3 py-1.5 rounded-full border border-emerald-100 cursor-help">
                  {kw.word}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-slate-400 mt-3">Hover/tap a word to see the PSLE-precise definition.</p>
          </section>

          {/* ── Key concepts deck ── */}
          <SlideDeck
            label="Key concepts deck"
            slides={content.keyConcepts}
            currentIdx={conceptIdx}
            setIdx={setConceptIdx}
            accent="emerald"
            slug={slug}
            globalIdxOffset={0}
          />

          {/* ── Common mistakes deck — only rendered if authored.
                For Interactions the mistakes are baked into the Key
                Concept slides so we skip this section entirely. ── */}
          {content.commonMistakes.length > 0 && <SlideDeck
            label="Common mistakes deck"
            slides={content.commonMistakes}
            currentIdx={mistakeIdx}
            setIdx={setMistakeIdx}
            accent="rose"
            slug={slug}
            globalIdxOffset={content.keyConcepts.length}
          />}

          {/* ── Practice set ── */}
          <section className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Practice set</p>
                <p className="text-sm text-slate-700 mt-1">{practice.mcq.length} MCQ + {practice.oeq.length} OEQ shown · {practice.poolSize} in pool</p>
              </div>
              <button
                onClick={loadMorePractice}
                disabled={moreLoading || seenIds.length >= practice.poolSize}
                className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {moreLoading ? "Loading…" : seenIds.length >= practice.poolSize ? "Whole pool shown" : "More practice"}
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-xs font-bold text-slate-600 mb-2">MCQ ({practice.mcq.length})</p>
                <div className="space-y-2">
                  {practice.mcq.map((q, i) => <PracticeCard key={q.id} q={q} idx={i + 1} />)}
                </div>
              </div>
              <div>
                <p className="text-xs font-bold text-slate-600 mb-2 mt-4">OEQ ({practice.oeq.length})</p>
                <div className="space-y-2">
                  {practice.oeq.map((q, i) => <PracticeCard key={q.id} q={q} idx={i + 1} />)}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl px-4 py-3 border border-emerald-100">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-extrabold text-slate-900 mt-1 leading-none">{value}</p>
      {sub && <p className="text-[10px] text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

function SlideDeck({
  label,
  slides,
  currentIdx,
  setIdx,
  accent,
  slug,
  globalIdxOffset = 0,
}: {
  label: string;
  slides: MasterClassSlide[];
  currentIdx: number;
  setIdx: (n: number) => void;
  accent: "emerald" | "rose";
  slug: string;
  globalIdxOffset?: number;
}) {
  // TTS playback state — keyed on global slide idx so common-mistakes
  // deck can coexist later without colliding.
  // Per-segment TTS playback. The server returns N audio segments
  // (intro, one per bullet, scoring example, callout). We autoplay
  // them in order, and >> / << jump between segment indices.
  type Segment = { label: string; audio: string };  // audio = base64
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segIdx, setSegIdx] = useState(0);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Latest segIdx value the audio element should follow — avoids
  // closure staleness inside onended.
  const segIdxRef = useRef(0);
  segIdxRef.current = segIdx;

  // Fetch segments whenever the slide changes. Stop any active audio
  // first so we don't keep narrating the previous slide.
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setSegments([]);
    setSegIdx(0);
    setPlaying(false);
    setTtsError(null);
    let cancelled = false;
    (async () => {
      setTtsLoading(true);
      try {
        const globalIdx = globalIdxOffset + currentIdx;
        const res = await fetch(`/api/admin/master-class/${slug}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slideIdx: globalIdx, force: false }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          if (!cancelled) setTtsError(d.error ?? `TTS failed (${res.status})`);
          return;
        }
        const data = await res.json() as { segments: Segment[] };
        if (!cancelled) setSegments(data.segments);
      } catch (err) {
        if (!cancelled) setTtsError((err as Error).message);
      } finally {
        if (!cancelled) setTtsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentIdx, slug, globalIdxOffset]);

  // Play the segment at segIdx whenever it changes (and segments are
  // available). Autoplay starts on initial load; manual >>/<< also
  // routes through here.
  useEffect(() => {
    if (segments.length === 0 || segIdx >= segments.length) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(false);
      return;
    }
    // Tear down any existing audio first.
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const seg = segments[segIdx];
    const url = `data:audio/mpeg;base64,${seg.audio}`;
    const audio = new Audio(url);
    audio.muted = muted;
    audio.onended = () => {
      // Advance to next segment if any remain.
      const next = segIdxRef.current + 1;
      if (next < segments.length) setSegIdx(next);
      else setPlaying(false);
    };
    audio.onerror = () => {
      setPlaying(false);
      setTtsError("Audio playback failed");
    };
    audioRef.current = audio;
    audio.play().then(() => setPlaying(true)).catch(() => {
      // Browser blocked autoplay — common on first slide before any
      // user interaction. Stay paused; user can press Play.
      setPlaying(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, segIdx]);

  // Keep audio.muted in sync with the muted state.
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  function togglePlay() {
    const a = audioRef.current;
    if (!a) {
      // Trigger initial play by re-setting segIdx to itself; the
      // segments effect above will create a new audio element.
      if (segments.length > 0) setSegIdx(s => s);
      return;
    }
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
  }
  function jumpNext() {
    if (segIdx + 1 < segments.length) setSegIdx(segIdx + 1);
  }
  function jumpPrev() {
    if (segIdx > 0) setSegIdx(segIdx - 1);
  }
  async function regenerate() {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setSegments([]);
    setSegIdx(0);
    setTtsLoading(true);
    setTtsError(null);
    try {
      const globalIdx = globalIdxOffset + currentIdx;
      const res = await fetch(`/api/admin/master-class/${slug}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slideIdx: globalIdx, force: true }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setTtsError(d.error ?? `TTS failed (${res.status})`);
        return;
      }
      const data = await res.json() as { segments: Segment[] };
      setSegments(data.segments);
    } catch (err) {
      setTtsError((err as Error).message);
    } finally {
      setTtsLoading(false);
    }
  }

  const slide = slides[currentIdx];
  const ringClass = accent === "emerald" ? "ring-emerald-200" : "ring-rose-200";
  const accentText = accent === "emerald" ? "text-emerald-700" : "text-rose-700";
  const accentBg = accent === "emerald" ? "bg-emerald-50" : "bg-rose-50";
  const accentDot = accent === "emerald" ? "bg-emerald-500" : "bg-rose-500";
  return (
    <section className={`bg-white border border-slate-100 rounded-2xl p-5 shadow-sm ring-1 ${ringClass}`}>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <p className={`text-[10px] font-bold uppercase tracking-wider ${accentText}`}>{label}</p>
        <div className="flex items-center gap-1.5">
          <button
            onClick={jumpPrev}
            disabled={ttsLoading || segIdx === 0}
            className="w-8 h-8 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 inline-flex items-center justify-center"
            title="Previous bullet"
          >
            <span className="material-symbols-outlined text-base">fast_rewind</span>
          </button>
          <button
            onClick={togglePlay}
            disabled={ttsLoading || segments.length === 0}
            className={`w-9 h-9 rounded-full inline-flex items-center justify-center ${playing ? "bg-rose-500 text-white hover:bg-rose-600" : "bg-emerald-500 text-white hover:bg-emerald-600"} disabled:opacity-40`}
            title={playing ? "Pause" : "Play"}
          >
            <span className="material-symbols-outlined text-base">{ttsLoading ? "progress_activity" : playing ? "pause" : "play_arrow"}</span>
          </button>
          <button
            onClick={jumpNext}
            disabled={ttsLoading || segIdx >= segments.length - 1}
            className="w-8 h-8 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 inline-flex items-center justify-center"
            title="Next bullet"
          >
            <span className="material-symbols-outlined text-base">fast_forward</span>
          </button>
          <button
            onClick={() => setMuted(m => !m)}
            className={`w-8 h-8 rounded-full inline-flex items-center justify-center ml-1 ${muted ? "bg-slate-200 text-slate-500" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}
            title={muted ? "Unmute" : "Mute"}
          >
            <span className="material-symbols-outlined text-base">{muted ? "volume_off" : "volume_up"}</span>
          </button>
          {segments.length > 0 && (
            <span className="text-[10px] text-slate-400 ml-2">
              {segments[segIdx]?.label ?? "—"} · {segIdx + 1}/{segments.length}
            </span>
          )}
          <button
            onClick={regenerate}
            disabled={ttsLoading}
            className="text-[10px] text-slate-400 hover:text-slate-700 disabled:opacity-50 ml-2"
            title="Re-generate narration (skip cache)"
          >
            ↻ Re-gen
          </button>
          <p className="text-[10px] text-slate-400 ml-3">slide {currentIdx + 1} / {slides.length}</p>
        </div>
      </div>
      {ttsError && (
        <p className="text-[10px] text-rose-600 mb-2">{ttsError}</p>
      )}
      {slide && (
        <div className="min-h-[260px] flex flex-col">
          <h2 className="text-xl lg:text-2xl font-bold text-slate-900 leading-tight">{slide.title}</h2>
          {slide.body && (
            <p
              className="text-sm text-slate-600 mt-2 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.body) }}
            />
          )}
          {slide.pieChart && (
            <div className="mt-5 flex items-center gap-5">
              <PieChart percentage={slide.pieChart.percentage} accent={accent} />
              <div className="flex-1">
                <p className="text-3xl font-extrabold text-slate-900">{slide.pieChart.percentage}%</p>
                <p className="text-xs text-slate-500">{slide.pieChart.label}</p>
                {slide.pieChart.caption && <p className="text-xs text-slate-400 mt-1">{slide.pieChart.caption}</p>}
              </div>
            </div>
          )}
          {slide.bullets && slide.bullets.length > 0 && (
            <ul className="mt-4 space-y-2">
              {slide.bullets.map((b, i) => (
                <li key={i} className="text-sm text-slate-700 flex gap-3">
                  <span className={`w-1.5 h-1.5 rounded-full ${accentDot} mt-2 flex-shrink-0`} />
                  <span className="whitespace-pre-line" dangerouslySetInnerHTML={{ __html: renderInlineMd(b) }} />
                </li>
              ))}
            </ul>
          )}
          {slide.scoringExample && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                Scoring example
              </p>
              <p
                className="text-xs text-slate-600 italic mb-3"
                dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.scoringExample.scenario) }}
              />
              <div className="space-y-2">
                <div className="rounded-lg bg-rose-50 border border-rose-100 px-3 py-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-rose-700 mr-2">{slide.scoringExample.oneMark.label}</span>
                  <span
                    className="text-sm text-rose-700"
                    dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.scoringExample.oneMark.text) }}
                  />
                </div>
                <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 mr-2">{slide.scoringExample.fullMarks.label}</span>
                  <span
                    className="text-sm text-emerald-700"
                    dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.scoringExample.fullMarks.text) }}
                  />
                </div>
              </div>
            </div>
          )}
          {slide.callout && (
            <div
              className={`mt-4 ${accentBg} rounded-xl px-4 py-3 text-sm italic ${accentText}`}
              dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.callout) }}
            />
          )}
        </div>
      )}
      <div className="mt-5 flex items-center justify-between">
        <button
          onClick={() => setIdx(Math.max(0, currentIdx - 1))}
          disabled={currentIdx === 0}
          className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200 disabled:opacity-40"
        >← Prev</button>
        <div className="flex gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={`w-2 h-2 rounded-full ${i === currentIdx ? accentDot : "bg-slate-200"}`}
            />
          ))}
        </div>
        <button
          onClick={() => setIdx(Math.min(slides.length - 1, currentIdx + 1))}
          disabled={currentIdx === slides.length - 1}
          className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-40"
        >Next →</button>
      </div>
    </section>
  );
}

function PracticeCard({ q, idx }: { q: PracticeQuestion; idx: number }) {
  const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as string[]) : null;
  const isPsle = /\bPSLE\b/i.test(q.examPaper.title);
  return (
    <div className="border border-slate-100 rounded-xl p-3 bg-slate-50/50">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          {idx}. Q{q.questionNum} · {q.marksAvailable ?? "?"}m · {q.examPaper.title.slice(0, 50)} {q.examPaper.year ?? ""}
        </p>
        {isPsle && <span className="text-[9px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">PSLE</span>}
      </div>
      <p className="text-xs text-slate-800 leading-relaxed">{q.transcribedStem?.slice(0, 320)}</p>
      {opts && opts.length === 4 && (
        <ul className="mt-2 space-y-0.5">
          {opts.map((o, i) => <li key={i} className="text-[11px] text-slate-600">({i + 1}) {o}</li>)}
        </ul>
      )}
      {q.answer && (
        <p className="text-[11px] text-emerald-700 mt-2 font-semibold">Answer: {q.answer.slice(0, 200)}</p>
      )}
    </div>
  );
}

// Minimal markdown — handles **bold** for emphasis in bullets.
function renderInlineMd(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// SVG donut chart — single colored slice = `percentage`, grey fills
// the rest. Stroke-based so we don't need a fill / center wedge.
function PieChart({ percentage, accent }: { percentage: number; accent: "emerald" | "rose" }) {
  const size = 120;
  const stroke = 22;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, percentage)) / 100) * c;
  const strokeColor = accent === "emerald" ? "#10b981" : "#f43f5e";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={strokeColor}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${c}`}
        strokeDashoffset={c / 4}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        strokeLinecap="butt"
      />
    </svg>
  );
}
