"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import type { MasterClassContent, MasterClassSlide } from "@/data/master-class";
import { parseSlideScript } from "@/lib/master-class/parse-script";
import { renderInlineMd } from "@/lib/master-class/render";

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
  const params = useSearchParams();
  const userId = params.get("userId") ?? "";
  // ?focus=causal-chain,mutual-benefits → filter slide deck to only
  // the slides teaching those sub-topics. Used by the mastery-quiz
  // review page when it sends a student back to re-watch weak areas.
  const focusParam = params.get("focus") ?? "";
  const focusIds = focusParam ? focusParam.split(",").map(s => s.trim()).filter(Boolean) : [];
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
  // Admin-editable per-slide mega-textarea scripts. Fetched once on
  // mount; the deck holds local draft state and pushes back via onSave.
  const [keyScripts, setKeyScripts] = useState<string[] | null>(null);
  const [mistakeScripts, setMistakeScripts] = useState<string[] | null>(null);

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
    // Load the per-slide scripts in parallel — the editor reads from
    // these and Save sends them back.
    fetch(`/api/admin/master-class/${slug}/scripts`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then((d: { keyConceptScripts: string[]; commonMistakeScripts: string[] }) => {
        setKeyScripts(d.keyConceptScripts);
        setMistakeScripts(d.commonMistakeScripts);
      })
      .catch(() => { /* non-fatal — editor falls back to bundled content */ });
  }, [allowed, slug]);

  async function saveScripts(which: "key" | "mistake", next: string[]) {
    const body = {
      keyConceptScripts: which === "key" ? next : (keyScripts ?? []),
      commonMistakeScripts: which === "mistake" ? next : (mistakeScripts ?? []),
    };
    const res = await fetch(`/api/admin/master-class/${slug}/scripts`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Save failed (${res.status})`);
    if (which === "key") setKeyScripts(next); else setMistakeScripts(next);
  }

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

          {/* ── Icon editor — regenerates the per-class artwork
              shown on the student list page via Gemini image gen. */}
          <IconEditor slug={slug} title={content.title} subject={content.subject} />

          {/* ── Sub-topic classifier (admin tool) ──
              Classifies every master-bank question on this topic into
              one of the Master Class sub-topics. Required for the
              Mastery Quiz flow — quizzes pull questions balanced
              across sub-topics. */}
          <ClassifierPanel slug={slug} subTopics={content.subTopics ?? []} />

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

          {/* ── Focused-replay banner — appears when redirected here
              with ?focus=<weak-sub-topics>. Filters the deck below to
              just those slides. ── */}
          {focusIds.length > 0 && (() => {
            const focusLabels = focusIds
              .map(id => content.subTopics?.find(t => t.id === id)?.label ?? id)
              .join(", ");
            return (
              <section className="bg-amber-50 border border-amber-200 rounded-2xl p-4 shadow-sm flex items-baseline justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-amber-800">Focused replay</p>
                  <p className="text-sm text-amber-900 mt-1">
                    Reviewing: <strong className="font-bold">{focusLabels}</strong>
                  </p>
                </div>
                <a
                  href={`/admin/master-class/${slug}?userId=${userId}`}
                  className="text-[11px] font-bold text-amber-800 underline hover:text-amber-900"
                >
                  Show full deck
                </a>
              </section>
            );
          })()}

          {/* ── Key concepts deck ──
              When ?focus= is set, hand the deck only the slides whose
              sub-topic IDs match. slideIdx in subTopics is the 0-based
              position into keyConcepts; we use it to filter. */}
          {(() => {
            const filteredSlides = focusIds.length > 0
              ? focusIds
                  .map(id => content.subTopics?.find(t => t.id === id)?.slideIdx ?? -1)
                  .filter(idx => idx >= 0 && idx < content.keyConcepts.length)
                  .map(idx => content.keyConcepts[idx])
              : content.keyConcepts;
            return (
              <SlideDeck
                label={focusIds.length > 0 ? "Focused replay deck" : "Key concepts deck"}
                slides={filteredSlides}
                currentIdx={conceptIdx}
                setIdx={setConceptIdx}
                accent="emerald"
                slug={slug}
                globalIdxOffset={0}
                scripts={focusIds.length > 0 ? null : keyScripts}
                onSaveScripts={focusIds.length > 0 ? undefined : (next) => saveScripts("key", next)}
              />
            );
          })()}

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
            scripts={mistakeScripts}
            onSaveScripts={(next) => saveScripts("mistake", next)}
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
  scripts,
  onSaveScripts,
}: {
  label: string;
  slides: MasterClassSlide[];
  currentIdx: number;
  setIdx: (n: number) => void;
  accent: "emerald" | "rose";
  slug: string;
  globalIdxOffset?: number;
  // Admin editor wiring. When `scripts` is provided, the deck shows
  // the mega-textarea editor below the preview and uses the parsed
  // draft scripts to render slides (overlaid on the structured YAML
  // fields like pieChart / scoringExample that the textarea doesn't
  // cover). When null/undefined, the deck is view-only.
  scripts?: string[] | null;
  onSaveScripts?: (next: string[]) => Promise<void>;
}) {
  // Editor state.
  //   typed[i]     — live textarea value (changes on every keystroke)
  //   committed[i] — drives the rendered preview; only updates when
  //                  the author presses ↻ Re-render preview or Save.
  // This keeps the preview from jumping mid-edit.
  //
  // Seed once via loadedRef. We do NOT re-seed when `scripts` prop
  // changes later (e.g. after a Save round-trips and the parent
  // updates its keyScripts). Re-seeding mid-edit caused the
  // Re-render-preview button to lock because typed got snapped back
  // to scripts (== committed) and typedDirty went false.
  const editable = scripts !== undefined && scripts !== null && !!onSaveScripts;
  const [typed, setTyped] = useState<string[]>(scripts ?? []);
  const [committed, setCommitted] = useState<string[]>(scripts ?? []);
  const seededRef = useRef(false);
  useEffect(() => {
    if (scripts && !seededRef.current) {
      setTyped(scripts);
      setCommitted(scripts);
      seededRef.current = true;
    }
  }, [scripts]);
  // Preview slide = YAML slide overlaid with parsed committed script.
  // The script is the SOURCE OF TRUTH for title/body/bullets/callout/
  // narration — deleting any of them in the textarea must clear them
  // in the preview (else "I removed the callout but it still shows").
  // pieChart / scoringExample / cta / diagramPrompt are kept from the
  // YAML since the textarea can't represent them.
  const previewSlides = useMemo(() => {
    if (!editable) return slides;
    return slides.map((s, i) => {
      const script = committed[i];
      if (!script || !script.trim()) return s;
      const parsed = parseSlideScript(script);
      return {
        ...s,
        title: parsed.title || s.title,
        body: parsed.body,
        bullets: parsed.bullets,
        callout: parsed.callout,
        narration: parsed.narration,
        pieChart: s.pieChart,
        scoringExample: s.scoringExample,
        cta: s.cta,
        diagramPrompt: s.diagramPrompt,
        diagramImage: s.diagramImage,
      };
    });
  }, [editable, slides, committed]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const typedDirty = editable && (typed[currentIdx] ?? "") !== (committed[currentIdx] ?? "");
  const savedDirty = editable && JSON.stringify(typed) !== JSON.stringify(scripts);
  function rerenderPreview() {
    setCommitted([...typed]);
  }
  async function handleSave() {
    if (!onSaveScripts) return;
    setSaveState("saving");
    setSaveError(null);
    try {
      // Commit typed → preview on save too, so what's saved matches
      // what's shown.
      setCommitted([...typed]);
      await onSaveScripts(typed);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1800);
    } catch (e) {
      setSaveState("error");
      setSaveError((e as Error).message);
    }
  }
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
  // Pause inserted between bullet segments for breathing room. Stored
  // as a ref so pause/mute/slide-change can cancel a pending advance.
  const INTER_SEGMENT_PAUSE_MS = 1600;
  const pendingAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelPendingAdvance() {
    if (pendingAdvanceRef.current) {
      clearTimeout(pendingAdvanceRef.current);
      pendingAdvanceRef.current = null;
    }
  }

  // Reset playback state whenever the slide changes. We don't trigger
  // ElevenLabs generation here (editing flow involves a lot of slide
  // flipping), but we DO call the TTS endpoint with `cacheOnly:true`
  // — that's a file-existence check, no API call. If every segment
  // is on disk, segments populate and the "Generate" button hides;
  // if anything is missing, segments stay empty and the button shows.
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
      try {
        const globalIdx = globalIdxOffset + currentIdx;
        const res = await fetch(`/api/master-class/${slug}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slideIdx: globalIdx, cacheOnly: true }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json() as { cached?: boolean; segments?: Segment[] };
        if (cancelled) return;
        if (data.cached && Array.isArray(data.segments) && data.segments.length > 0) {
          setSegments(data.segments);
        }
      } catch { /* ignore — leaves button in "Generate" state */ }
    })();
    return () => { cancelled = true; };
  }, [currentIdx, slug, globalIdxOffset]);

  // Explicit on-demand fetch — wired to both "Generate audio" and
  // "Re-gen" buttons. `force=true` invalidates the server-side cache
  // (used when text changes); regular fetches reuse the cached MP3.
  async function fetchSegments(force: boolean) {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setSegments([]);
    setSegIdx(0);
    setTtsError(null);
    setTtsLoading(true);
    try {
      const globalIdx = globalIdxOffset + currentIdx;
      const res = await fetch(`/api/master-class/${slug}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slideIdx: globalIdx, force }),
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
      // Pause briefly between segments so bullets don't blur together.
      // Use a ref-tracked timeout so pause/mute/slide-change can
      // cancel a pending advance.
      cancelPendingAdvance();
      const next = segIdxRef.current + 1;
      if (next < segments.length) {
        pendingAdvanceRef.current = setTimeout(() => {
          pendingAdvanceRef.current = null;
          setSegIdx(next);
        }, INTER_SEGMENT_PAUSE_MS);
      } else {
        setPlaying(false);
      }
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
      if (segments.length > 0) setSegIdx(s => s);
      return;
    }
    if (playing) {
      cancelPendingAdvance();
      a.pause();
      setPlaying(false);
    } else {
      a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }
  function jumpNext() {
    cancelPendingAdvance();
    if (segIdx + 1 < segments.length) setSegIdx(segIdx + 1);
  }
  function jumpPrev() {
    cancelPendingAdvance();
    if (segIdx > 0) setSegIdx(segIdx - 1);
  }
  function generateAudio() { return fetchSegments(false); }
  function regenerate() { return fetchSegments(true); }

  const slide = previewSlides[currentIdx];
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
          {/* Generate audio button — only shown when we don't have
              segments yet for the current slide. Burns an ElevenLabs
              call (or hits the on-disk cache if the script hasn't
              changed). Re-gen below it forces fresh generation. */}
          {segments.length === 0 && (
            <button
              onClick={generateAudio}
              disabled={ttsLoading}
              className="text-[10px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-200 rounded-md px-2 py-1 ml-1 disabled:opacity-50"
              title="Generate ElevenLabs narration for this slide (uses cache if script hasn't changed)"
            >
              {ttsLoading ? "Generating…" : "🔊 Generate audio"}
            </button>
          )}
          <button
            onClick={regenerate}
            disabled={ttsLoading}
            className="text-[10px] font-bold text-amber-700 bg-amber-50 hover:bg-amber-100 ring-1 ring-amber-200 rounded-md px-2 py-1 ml-2 disabled:opacity-50"
            title="Re-generate narration from scratch (skip the cached MP3 — use after editing the script)"
          >
            {ttsLoading ? "Re-generating…" : "↻ Re-generate voice"}
          </button>
          <p className="text-[10px] text-slate-400 ml-3">slide {currentIdx + 1} / {slides.length}</p>
        </div>
      </div>
      {ttsError && (
        <p className="text-[10px] text-rose-600 mb-2">{ttsError}</p>
      )}
      {slide && (() => {
        // Map the current segment index to which content block is
        // being narrated. Segment order in the API: intro (0), bullets
        // (1..N), scoring example (if any), callout (if any).
        const numBullets = slide.bullets?.length ?? 0;
        const hasScoring = !!slide.scoringExample;
        const hasCallout = !!slide.callout;
        const isIntroActive = playing && segIdx === 0;
        const activeBulletIdx = playing && segIdx >= 1 && segIdx <= numBullets ? segIdx - 1 : -1;
        const isScoringActive = playing && hasScoring && segIdx === numBullets + 1;
        const isCalloutActive = playing && hasCallout && segIdx === numBullets + (hasScoring ? 2 : 1);
        // Highlight style — soft tinted ring with the deck's accent
        // colour. Explicit class strings because Tailwind JIT can't
        // see template-literal class names at build time.
        const hlIntro = accent === "emerald"
          ? "bg-emerald-50/60 ring-1 ring-emerald-200 rounded-xl px-3 py-2 -mx-3"
          : "bg-rose-50/60 ring-1 ring-rose-200 rounded-xl px-3 py-2 -mx-3";
        const hlBullet = accent === "emerald"
          ? "bg-emerald-50/70 ring-1 ring-emerald-200 rounded-lg pl-2 pr-3 py-1.5 -ml-2 transition-all"
          : "bg-rose-50/70 ring-1 ring-rose-200 rounded-lg pl-2 pr-3 py-1.5 -ml-2 transition-all";
        const introHl = isIntroActive ? hlIntro : "";
        const bulletHlClass = (i: number) =>
          activeBulletIdx === i ? hlBullet : "px-0 py-1.5 transition-all";
        const scoringHl = accent === "emerald" ? "ring-2 ring-emerald-300" : "ring-2 ring-rose-300";
        const calloutHl = accent === "emerald" ? "ring-2 ring-emerald-400" : "ring-2 ring-rose-400";
        return (
        <div className="min-h-[520px] sm:min-h-[860px] flex flex-col">
          <h2 className={`text-xl lg:text-2xl font-bold text-slate-900 leading-tight transition-all ${introHl}`}>{slide.title}</h2>
          {slide.body && (
            <p
              className="text-sm text-slate-600 mt-2 leading-relaxed whitespace-pre-line"
              dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.body) }}
            />
          )}
          {slide.diagramImage && (
            <div className="mt-4 flex justify-center bg-white border border-slate-200 rounded-xl p-3">
              <img src={slide.diagramImage} alt="" className="max-w-full max-h-72 object-contain" />
            </div>
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
            <ul className="mt-4 space-y-1">
              {slide.bullets.map((b, i) => (
                <li
                  key={i}
                  className={`text-sm text-slate-700 flex gap-3 ${bulletHlClass(i)}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${activeBulletIdx === i ? "bg-slate-900" : accentDot} mt-2 flex-shrink-0 transition-colors`} />
                  <span className="whitespace-pre-line" dangerouslySetInnerHTML={{ __html: renderInlineMd(b) }} />
                </li>
              ))}
            </ul>
          )}
          {slide.scoringExample && (
            <div className={`mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 transition-all ${isScoringActive ? scoringHl : ""}`}>
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
              className={`mt-4 ${accentBg} rounded-xl px-4 py-3 text-sm italic ${accentText} transition-all ${isCalloutActive ? calloutHl : ""}`}
              dangerouslySetInnerHTML={{ __html: renderInlineMd(slide.callout) }}
            />
          )}
          {slide.cta && (
            <CtaLauncher slug={slug} label={slide.cta.label} />
          )}
        </div>
        );
      })()}
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

      {editable && (
        <div className="mt-6 border-t border-slate-200 pt-4">
          <div className="flex items-baseline justify-between mb-2 gap-3 flex-wrap">
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                Script · slide {currentIdx + 1} / {slides.length}
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5">
                First line = title · <code className="bg-slate-100 px-1 rounded">- </code> bullet · <code className="bg-slate-100 px-1 rounded">-- </code> sub-bullet · <code className="bg-slate-100 px-1 rounded">&gt; </code> callout · <code className="bg-slate-100 px-1 rounded">~ </code> YAML-only note · <code className="bg-slate-100 px-1 rounded">{"{…}"}</code> audio-only · <code className="bg-slate-100 px-1 rounded">**bold**</code>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={rerenderPreview}
                className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
                title="Apply the current text to the preview"
              >↻ Re-render preview</button>
              <button
                onClick={handleSave}
                disabled={saveState === "saving"}
                className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-40"
                title="Save script changes to the database"
              >
                {saveState === "saving" ? "Saving…"
                  : saveState === "saved" ? "✓ Saved"
                  : saveState === "error" ? "✕ Retry"
                  : "💾 Save"}
              </button>
            </div>
          </div>
          {saveError && <p className="text-[10px] text-rose-600 mb-1">{saveError}</p>}
          {(slide?.pieChart || slide?.scoringExample || slide?.cta) && (
            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
              📌 This slide has YAML-only blocks attached (pieChart / scoringExample / cta) — shown as <code className="bg-amber-100 px-1 rounded">~ </code>placeholders in the script. The textarea controls title, body, bullets, callout, and narration.
            </p>
          )}
          <textarea
            value={typed[currentIdx] ?? ""}
            onChange={e => setTyped(prev => {
              const next = [...prev];
              while (next.length <= currentIdx) next.push("");
              next[currentIdx] = e.target.value;
              return next;
            })}
            rows={Math.min(20, Math.max(8, (typed[currentIdx] ?? "").split("\n").length + 1))}
            spellCheck={false}
            className="w-full font-mono text-xs leading-relaxed text-slate-800 border border-slate-200 rounded-lg p-3 focus:outline-none focus:border-slate-400 resize-y"
            placeholder="First line is the title. Blank line then paragraphs of body. Lines starting with - become bullets. Lines starting with > become the callout. Wrap voice-only text in {curly braces} anywhere."
          />
          <p className="text-[10px] text-slate-400 mt-1">
            {typedDirty ? "Unsaved typing — press ↻ to update preview." : savedDirty ? "Preview updated — press 💾 Save to persist." : "In sync with saved version."}
          </p>
        </div>
      )}
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

function IconEditor({ slug, title, subject }: { slug: string; title: string; subject: string }) {
  const [prompt, setPrompt] = useState("");
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // Cache-buster bumped on every successful regen so the <img> below
  // refetches instead of showing a stale cached PNG.
  const [iconVersion, setIconVersion] = useState(0);

  useEffect(() => {
    fetch(`/api/admin/master-class/${slug}/icon`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { prompt: string | null; defaultPrompt: string } | null) => {
        if (!d) return;
        setDefaultPrompt(d.defaultPrompt);
        setPrompt(d.prompt ?? d.defaultPrompt);
      })
      .catch(() => { /* non-fatal */ });
  }, [slug]);

  async function regenerate() {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const res = await fetch(`/api/admin/master-class/${slug}/icon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? `Failed (${res.status})`); return; }
      setOk(`Updated (model: ${data.model}, ${(data.bytes / 1024).toFixed(1)} KB)`);
      setIconVersion(v => v + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  void title; void subject; // surfaced for prompt context, used server-side
  return (
    <section className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">Class icon</p>
      <div className="flex gap-5 items-start flex-wrap">
        <div className="w-28 h-28 rounded-2xl bg-slate-50 border border-slate-200 overflow-hidden flex items-center justify-center shrink-0">
          <img
            src={`/api/master-class/${slug}/icon?v=${iconVersion}`}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.opacity = "0.3"; }}
          />
        </div>
        <div className="flex-1 min-w-[260px]">
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={5}
            spellCheck={false}
            className="w-full text-xs leading-relaxed text-slate-800 border border-slate-200 rounded-lg p-3 focus:outline-none focus:border-slate-400 resize-y"
            placeholder="Describe the icon you want — style, colours, subject…"
          />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <button
              onClick={regenerate}
              disabled={busy || !prompt.trim()}
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-40"
            >
              {busy ? "Generating…" : "🎨 Regenerate icon"}
            </button>
            {defaultPrompt && (
              <button
                onClick={() => setPrompt(defaultPrompt)}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
                title="Reset to the default anime-style prompt"
              >Reset to default</button>
            )}
            {ok && <span className="text-[10px] text-emerald-700">{ok}</span>}
            {err && <span className="text-[10px] text-rose-600">{err}</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

function CtaLauncher({ slug, label }: { slug: string; label: string }) {
  const userId = useSearchParams().get("userId") ?? "";
  const router = useRouter();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [studentId, setStudentId] = useState("");
  const [open, setOpen] = useState(false);

  async function launch() {
    if (!studentId.trim()) {
      setError("Please enter a student ID first.");
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const res = await fetch(`/api/master-class/${slug}/start-quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: studentId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Failed (${res.status})`);
        return;
      }
      // Navigate to the quiz. userId here is the STUDENT id (the
      // assignee), because that's whose answers the quiz collects.
      router.push(`/quiz/${data.paperId}?userId=${studentId.trim()}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="mt-auto pt-6 flex flex-col items-center gap-3">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="px-8 py-4 rounded-2xl bg-emerald-600 text-white text-base font-bold hover:bg-emerald-700 shadow-lg hover:shadow-xl transition-all flex items-center gap-2"
        >
          <span className="material-symbols-outlined">play_circle</span>
          {label}
        </button>
      ) : (
        <div className="w-full max-w-md bg-slate-50 rounded-2xl border border-slate-200 p-5 space-y-3">
          <p className="text-xs font-bold text-slate-700">Launch quiz — pick a student</p>
          <p className="text-[10px] text-slate-400">
            Admin: enter the student ID this quiz should be assigned to. Pulled from /home/&lt;userId&gt; URLs.
          </p>
          <input
            type="text"
            placeholder="cmnsa6bww006bgmuwflevt143"
            value={studentId}
            onChange={e => setStudentId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:border-emerald-400"
          />
          <div className="flex gap-2">
            <button
              onClick={launch}
              disabled={launching || !studentId.trim()}
              className="flex-1 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:bg-slate-300"
            >
              {launching ? "Spawning quiz…" : "Launch"}
            </button>
            <button
              onClick={() => { setOpen(false); setError(null); }}
              className="px-4 py-2 rounded-xl text-slate-500 text-sm font-bold hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
      )}
      <p className="text-[10px] text-slate-400">Session userId: <code className="text-slate-600">{userId.slice(0, 12)}…</code></p>
    </div>
  );
}

function ClassifierPanel({
  slug,
  subTopics,
}: {
  slug: string;
  subTopics: Array<{ id: string; label: string; description: string }>;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<null | {
    totalCandidates: number;
    classified: number;
    unclassified: number;
    distribution: Record<string, number>;
  }>(null);
  const [error, setError] = useState<string | null>(null);
  const [forceReclassify, setForceReclassify] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/master-class/${slug}/classify-subtopics${forceReclassify ? "?force=1" : ""}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Failed (${res.status})`);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Sub-topic classifier</p>
        <label className="text-[10px] text-slate-400 flex items-center gap-1.5">
          <input type="checkbox" checked={forceReclassify} onChange={e => setForceReclassify(e.target.checked)} />
          Re-classify already-tagged
        </label>
      </div>
      <p className="text-xs text-slate-600 mb-3">
        Tags every master-bank question on this topic with one of these sub-topic IDs. Required for the Mastery Quiz to draw balanced questions per concept.
      </p>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {subTopics.map(t => (
          <span key={t.id} title={t.description} className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2.5 py-1 rounded-full cursor-help">
            {t.id}
          </span>
        ))}
      </div>
      <button
        onClick={run}
        disabled={running}
        className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
      >
        {running ? "Classifying…" : "Run classifier"}
      </button>
      {error && <p className="text-xs text-rose-600 mt-3">{error}</p>}
      {result && (
        <div className="mt-4 text-xs text-slate-700 space-y-1">
          <p>
            <span className="font-bold">{result.classified}</span> classified ·{" "}
            <span className="font-bold">{result.unclassified}</span> unclassified ·{" "}
            <span className="text-slate-400">{result.totalCandidates} candidates</span>
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {subTopics.map(t => (
              <div key={t.id} className="flex items-baseline justify-between bg-slate-50 rounded-lg px-3 py-1.5">
                <span className="text-slate-700">{t.label}</span>
                <span className="font-bold text-slate-900">{result.distribution[t.id] ?? 0}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// renderInlineMd moved to @/lib/master-class/render so the student
// player and the admin workshop share the same rendering rules.

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
