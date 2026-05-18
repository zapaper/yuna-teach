"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { getMasterClass, type MasterClassContent, type MasterClassSlide } from "@/data/master-class";

export default function Page() {
  return (
    <Suspense>
      <MasterClassPlayer />
    </Suspense>
  );
}

function MasterClassPlayer() {
  const slug = (useParams() as { slug?: string }).slug ?? "";
  const params = useSearchParams();
  const userId = params.get("userId") ?? "";
  const focusParam = params.get("focus") ?? "";
  const focusIds = focusParam ? focusParam.split(",").map(s => s.trim()).filter(Boolean) : [];
  const router = useRouter();

  const content = getMasterClass(slug);
  const [slideIdx, setSlideIdx] = useState(0);

  if (!content) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center p-6 text-center">
        <p className="text-sm text-slate-500">Master Class not found.</p>
      </div>
    );
  }

  // ?focus= → filter slides to weak sub-topics only.
  const filteredSlides = focusIds.length > 0
    ? focusIds
        .map(id => content.subTopics?.find(t => t.id === id)?.slideIdx ?? -1)
        .filter(idx => idx >= 0 && idx < content.keyConcepts.length)
        .map(idx => content.keyConcepts[idx])
    : content.keyConcepts;

  const slide = filteredSlides[slideIdx];

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-100">
        <div className="max-w-3xl mx-auto px-4 lg:px-8 py-3 flex items-center justify-between gap-3">
          <button
            onClick={() => router.push(`/master-class?userId=${userId}`)}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors shrink-0"
            title="Back"
          >
            <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
          </button>
          <h1 className="font-headline font-bold text-base lg:text-lg text-[#001e40] truncate">{content.title}</h1>
          <p className="text-xs text-slate-400 shrink-0">{slideIdx + 1} / {filteredSlides.length}</p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 lg:px-8 pt-5 pb-32">
        {focusIds.length > 0 && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs text-amber-900">
            <strong className="font-bold">Focused replay</strong> — only showing the slides you need to review.
            <button
              onClick={() => router.replace(`/master-class/${slug}?userId=${userId}`)}
              className="ml-2 underline hover:text-amber-700"
            >
              Show full deck
            </button>
          </div>
        )}

        {slide && (
          <SlideCard
            slide={slide}
            slug={slug}
            content={content}
            userId={userId}
            slideIdx={slideIdx}
            totalSlides={filteredSlides.length}
            onPrev={() => setSlideIdx(Math.max(0, slideIdx - 1))}
            onNext={() => setSlideIdx(Math.min(filteredSlides.length - 1, slideIdx + 1))}
          />
        )}

        {/* Progress dots */}
        <div className="mt-6 flex justify-center gap-1.5">
          {filteredSlides.map((_, i) => (
            <button
              key={i}
              onClick={() => setSlideIdx(i)}
              className={`h-1.5 rounded-full transition-all ${i === slideIdx ? "w-8 bg-emerald-500" : "w-1.5 bg-slate-300 hover:bg-slate-400"}`}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function SlideCard({
  slide,
  slug,
  content,
  userId,
  slideIdx,
  totalSlides,
  onPrev,
  onNext,
}: {
  slide: MasterClassSlide;
  slug: string;
  content: MasterClassContent;
  userId: string;
  slideIdx: number;
  totalSlides: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  type Segment = { label: string; audio: string };
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segIdx, setSegIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segIdxRef = useRef(0);
  segIdxRef.current = segIdx;
  const INTER_SEGMENT_PAUSE_MS = 1600;
  const pendingAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelPendingAdvance() {
    if (pendingAdvanceRef.current) {
      clearTimeout(pendingAdvanceRef.current);
      pendingAdvanceRef.current = null;
    }
  }

  // Fetch segments when slide changes.
  useEffect(() => {
    cancelPendingAdvance();
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
        const res = await fetch(`/api/master-class/${slug}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slideIdx, force: false }),
        });
        if (!res.ok) {
          if (!cancelled) setTtsError(`Narration unavailable (${res.status})`);
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
  }, [slideIdx, slug]);

  // Mobile autoplay between segments — iOS Safari and Android Chrome
  // only permit audio.play() inside an active user-gesture chain.
  // Creating a fresh `new Audio()` per segment in a useEffect breaks
  // that chain, so segment 2 onwards silently failed on mobile.
  //
  // Fix: reuse ONE audio element across the whole slide, and have
  // the `onended` handler advance to the next segment *inline*
  // (setTimeout → assign new src → call play() on the same element).
  // That keeps playback inside the same media-gesture context.
  //
  // The useEffect below only initialises the audio on FIRST load of
  // a segments batch. After that, all segment transitions flow
  // through onended. A ref-tracked flag tells the effect to skip
  // re-init when segIdx changes via onended (vs an external nudge
  // like prev/next button or slide change).
  const internalAdvanceRef = useRef(false);
  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;

  useEffect(() => {
    // Skip if this segIdx change was an internal advance from
    // onended — playback is already in-flight on the audio element.
    if (internalAdvanceRef.current) {
      internalAdvanceRef.current = false;
      return;
    }
    if (segments.length === 0 || segIdx >= segments.length) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    audio.muted = muted;
    audio.src = `data:audio/mpeg;base64,${segments[segIdx].audio}`;
    audio.onended = () => {
      const next = segIdxRef.current + 1;
      const segs = segmentsRef.current;
      if (next < segs.length) {
        pendingAdvanceRef.current = setTimeout(() => {
          pendingAdvanceRef.current = null;
          // Advance via the SAME audio element so the gesture
          // context survives. Mark this as an internal advance so
          // the useEffect's next firing skips re-initialising.
          internalAdvanceRef.current = true;
          audio.src = `data:audio/mpeg;base64,${segs[next].audio}`;
          audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
          setSegIdx(next);
        }, INTER_SEGMENT_PAUSE_MS);
      } else {
        setPlaying(false);
      }
    };
    audio.onerror = () => { setPlaying(false); setTtsError("Audio playback failed"); };
    audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, segIdx]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  // Stop audio on unmount — otherwise narration keeps reading after
  // the user clicks the quiz CTA and the page navigates away.
  useEffect(() => {
    return () => {
      cancelPendingAdvance();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, []);

  function togglePlay() {
    const a = audioRef.current;
    if (!a) { if (segments.length > 0) setSegIdx(s => s); return; }
    if (playing) { cancelPendingAdvance(); a.pause(); setPlaying(false); }
    else { a.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
  }

  // Map segIdx → highlight which content block is being narrated.
  const numBullets = slide.bullets?.length ?? 0;
  const isIntroActive = playing && segIdx === 0;
  const activeBulletIdx = playing && segIdx >= 1 && segIdx <= numBullets ? segIdx - 1 : -1;

  return (
    // Slide sizing — fixed height + width on tablet/desktop so every
    // slide feels uniform. min-h fallback on phones because long
    // bullet lists can outgrow a fixed phone-screen height. The card
    // body scrolls internally if content overflows (most slides fit).
    <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5 lg:p-7 min-h-[520px] sm:h-[720px] flex flex-col overflow-y-auto">
      {/* TTS controls */}
      <div className="flex items-center justify-between mb-4 gap-3">
        <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
          {ttsLoading ? "Loading narration…" : segments.length > 0 ? `${segments[segIdx]?.label ?? "—"} · ${segIdx + 1}/${segments.length}` : "Narration"}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { cancelPendingAdvance(); if (segIdx > 0) setSegIdx(segIdx - 1); }}
            disabled={ttsLoading || segIdx === 0}
            className="w-8 h-8 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 inline-flex items-center justify-center"
            title="Previous"
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
            onClick={() => { cancelPendingAdvance(); if (segIdx + 1 < segments.length) setSegIdx(segIdx + 1); }}
            disabled={ttsLoading || segIdx >= segments.length - 1}
            className="w-8 h-8 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 inline-flex items-center justify-center"
            title="Next"
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
        </div>
      </div>
      {ttsError && <p className="text-[10px] text-rose-600 mb-2">{ttsError}</p>}

      {/* Slide content — title + body both highlight together when
          the intro segment is being narrated (segIdx === 0). */}
      <div className={isIntroActive ? "bg-emerald-50/60 ring-1 ring-emerald-200 rounded-xl px-3 py-2 -mx-3 transition-all" : "transition-all"}>
        <h2 className="text-2xl lg:text-3xl font-bold text-slate-900 leading-tight">
          {slide.title}
        </h2>
        {slide.body && (
          <p
            className="text-base text-slate-700 mt-3 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.body) }}
          />
        )}
      </div>
      {slide.pieChart && (
        <div className="mt-5 flex items-center gap-5">
          <PieChart percentage={slide.pieChart.percentage} />
          <div className="flex-1">
            <p className="text-4xl font-extrabold text-slate-900">{slide.pieChart.percentage}%</p>
            <p className="text-sm text-slate-500">{slide.pieChart.label}</p>
            {slide.pieChart.caption && <p className="text-xs text-slate-400 mt-1">{slide.pieChart.caption}</p>}
          </div>
        </div>
      )}
      {slide.bullets && slide.bullets.length > 0 && (
        <ul className="mt-5 space-y-1">
          {slide.bullets.map((b, i) => (
            <li
              key={i}
              className={`text-sm lg:text-base text-slate-700 flex gap-3 ${activeBulletIdx === i ? "bg-emerald-50/70 ring-1 ring-emerald-200 rounded-lg pl-2 pr-3 py-1.5 -ml-2 transition-all" : "px-0 py-1.5 transition-all"}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${activeBulletIdx === i ? "bg-slate-900" : "bg-emerald-500"} mt-2 flex-shrink-0`} />
              <span className="whitespace-pre-line" dangerouslySetInnerHTML={{ __html: renderInlineMd(b) }} />
            </li>
          ))}
        </ul>
      )}
      {slide.scoringExample && (
        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Scoring example</p>
          <p className="text-xs text-slate-600 italic mb-3" dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.scoringExample.scenario) }} />
          <div className="space-y-2">
            <div className="rounded-lg bg-rose-50 border border-rose-100 px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-rose-700 mr-2">{slide.scoringExample.oneMark.label}</span>
              <span className="text-sm text-rose-700" dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.scoringExample.oneMark.text) }} />
            </div>
            <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 mr-2">{slide.scoringExample.fullMarks.label}</span>
              <span className="text-sm text-emerald-700" dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.scoringExample.fullMarks.text) }} />
            </div>
          </div>
        </div>
      )}
      {slide.callout && (
        <div className="mt-5 bg-emerald-50 text-emerald-800 rounded-xl px-4 py-3 text-sm italic" dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.callout) }} />
      )}
      {slide.cta && (
        <div className="mt-auto pt-8 flex justify-center">
          <CtaLauncher slug={slug} label={slide.cta.label} userId={userId} content={content} />
        </div>
      )}

      {/* Slide nav */}
      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          onClick={onPrev}
          disabled={slideIdx === 0}
          className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 text-sm font-bold hover:bg-slate-200 disabled:opacity-40"
        >
          ← Prev
        </button>
        <button
          onClick={onNext}
          disabled={slideIdx === totalSlides - 1}
          className="px-4 py-2 rounded-xl bg-[#001e40] text-white text-sm font-bold hover:bg-[#003366] disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function CtaLauncher({
  slug,
  label,
  userId,
  content,
}: {
  slug: string;
  label: string;
  userId: string;
  content: MasterClassContent;
}) {
  const router = useRouter();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  void content; // keep prop for future per-class voice / quiz spec config

  async function launch() {
    setLaunching(true);
    setError(null);
    try {
      const res = await fetch(`/api/master-class/${slug}/start-quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: userId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Failed (${res.status})`);
        return;
      }
      router.push(`/quiz/${data.paperId}?userId=${userId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={launch}
        disabled={launching}
        className="px-8 py-4 rounded-2xl bg-emerald-600 text-white text-base font-bold hover:bg-emerald-700 disabled:bg-slate-300 shadow-lg hover:shadow-xl transition-all flex items-center gap-2"
      >
        <span className="material-symbols-outlined">play_circle</span>
        {launching ? "Spawning quiz…" : label}
      </button>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

function PieChart({ percentage }: { percentage: number }) {
  const size = 120;
  const stroke = 22;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, percentage)) / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#10b981"
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${c}`}
        strokeDashoffset={c / 4}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function renderInlineMd(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
