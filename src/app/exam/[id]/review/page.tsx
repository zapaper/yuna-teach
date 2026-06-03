"use client";

import { Suspense, useEffect, useRef, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import FormattedText from "@/components/FormattedText";
import { VisualTextImages } from "@/components/EnglishQuizSection";
import { ReviewPenOverlay } from "@/components/ReviewPenOverlay";
import MathText from "@/components/MathText";
import BarDiagram, { type DiagramStep } from "@/components/BarDiagram";
import { FlagVoiceModal } from "@/components/FlagVoiceModal";
import { playClick } from "@/lib/sfx";
import { formatSubpartLabel } from "@/lib/subpart-label";
import React from "react";

/** Strip explanation tails from a one-word answer key so the review
 *  shows just the word (e.g. "Exhilaration | (spelling)" → "Exhilaration",
 *  "elated (= very happy)" → "elated"). Applied at display time so
 *  already-extracted dirty answers also render cleanly. Mirrors the
 *  extraction-time cleaner in src/lib/extraction.ts. */
// Strip the " | explanation" suffix the answer-key extractor sometimes
// emits for MCQ keys ("(3) | working notes…" → "(3)"). Then drop parens
// + dot. Returns the canonical "3" / "B" form to compare against an
// option number/letter. Empty string when input is blank.
function mcqAnswerHead(raw: string | null | undefined): string {
  if (!raw) return "";
  const head = raw.split("|")[0] ?? raw;
  return head.trim().replace(/[().]/g, "").trim();
}

function cleanOneWordAnswer(answer: string): string {
  if (!answer) return "";
  let s = answer.trim();
  const pipeIdx = s.indexOf("|");
  if (pipeIdx >= 0) s = s.slice(0, pipeIdx).trim();
  s = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  s = s.replace(/\s*[=—–]\s*.+$/, "").trim();
  s = s.replace(/\s+-\s+.+$/, "").trim();
  s = s.replace(/[.!?;:,]+$/, "").trim();
  return s;
}


/** Speak a Chinese MCQ sentence with the correct option substituted
 *  for the blank / underlined phrase. Browser TTS only — no network
 *  call. Used by the speaker button in the Chinese review path. */
function speakChineseMcq(stem: string, options: string[], correctAnsRaw: string): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  // Strip the optional " | explanation" suffix the extractor sometimes
  // bolts onto an MCQ key — keep only the head ("(3) | … " → "(3)").
  const correctNum = parseInt(mcqAnswerHead(correctAnsRaw), 10);
  const correctText = !isNaN(correctNum) && correctNum >= 1 && correctNum <= options.length ? options[correctNum - 1] ?? "" : "";
  // Strip the leading "Q1." / "Q1: " prefix some stems carry, then
  // substitute the answer into whichever marker the stem uses:
  //   1. **__phrase__** / **__**           → replace with correct option (synonym style)
  //   2. ______ (3+ underscores)           → replace blank with correct option
  //   3. No marker                         → just speak the stem (e.g. 以下哪一个句子是正确的？), then read the correct option
  let line = stem.replace(/^[Qq]?\s*\d+\s*[.:]\s*/, "").trim();
  let substituted = false;
  // **__phrase__** — the tested phrase, replace it with the correct option
  line = line.replace(/\*\*__(.*?)__\*\*/g, () => { substituted = true; return correctText; });
  // Bare __phrase__ — same treatment
  line = line.replace(/__(.*?)__/g, () => { substituted = true; return correctText; });
  // **bold** — leave as-is, strip markers for TTS
  line = line.replace(/\*\*(.*?)\*\*/g, "$1");
  // Cloze blanks
  line = line.replace(/_{3,}/g, () => { substituted = true; return correctText; });
  // If nothing was substituted (e.g. "以下哪一个句子是正确的？") then read the correct option as the answer.
  const speakText = substituted ? line : `${line} 答案：${correctText}`;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(speakText);
  utter.lang = "zh-CN";
  utter.rate = 0.85;
  window.speechSynthesis.speak(utter);
}

/** Submission image with spinner while loading */
function SubmissionImage({ src, alt, className, aspectRatio, imgStyle, onError }: {
  src: string; alt: string; className?: string; aspectRatio?: string;
  imgStyle?: React.CSSProperties;
  onError?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}) {
  const [loading, setLoading] = useState(true);
  // Reset loading when src changes
  const prevSrc = React.useRef(src);
  if (prevSrc.current !== src) { prevSrc.current = src; if (!loading) setLoading(true); }
  return (
    <div className="relative" style={aspectRatio ? { aspectRatio } : undefined}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/80 z-10 rounded-2xl">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={src}
        src={src}
        alt={alt}
        className={`${className ?? ""} pointer-events-none select-none`}
        draggable={false}
        style={{ WebkitTouchCallout: "none", WebkitUserDrag: "none", ...(imgStyle ?? {}) } as React.CSSProperties}
        onLoad={() => setLoading(false)}
        onError={(e) => { setLoading(false); onError?.(e); }}
      />
    </div>
  );
}

// Multi-part marker output (e.g. "(a) missing | (b) missing | (c) ___")
// counts as blank when every sub-part is a missing/blank/skipped marker.
// Used by the canvas-hiding gate so we don't render a tall white box
// just because the marker tagged each sub-part as missing instead of
// emitting "no answer detected" globally.
function isAllPartsMissing(saLower: string): boolean {
  if (!saLower) return false;
  const parts = saLower.split("|").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  const MISSING_RE = /^(?:\([^)]+\)\s*:?\s*)?(blank|none|empty|skipped|missing|incorrect|wrong|n\/?a|-)\.?$/i;
  return parts.every(p => MISSING_RE.test(p));
}

// AI-explainer cache reader. Newer entries are JSON ({solution,
// diagrams}); older ones are bare text from before the bar-model
// feature shipped. JSON.parse-then-shape-check handles both.
function parseElabCache(cached: string): { text: string; diagrams: DiagramStep[] } {
  try {
    const parsed = JSON.parse(cached) as { solution?: unknown; diagrams?: unknown };
    if (parsed && typeof parsed.solution === "string") {
      const diagrams = Array.isArray(parsed.diagrams) ? (parsed.diagrams as DiagramStep[]) : [];
      return { text: parsed.solution, diagrams };
    }
  } catch { /* not JSON */ }
  return { text: cached, diagrams: [] };
}

function renderUnderline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /__([^_]+)__/g;
  let lastIdx = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    parts.push(<span key={m.index} className="underline decoration-2">{m[1]}</span>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx === 0) return text;
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return <>{parts}</>;
}

interface ReviewQuestion {
  orderIndex: number;
  id: string;
  questionNum: string;
  pageIndex: number;
  answer: string | null;
  marksAwarded: number | null;
  marksAvailable: number | null;
  markingNotes: string | null;
  studentAnswer: string | null;
  elaboration: string | null;
  flagged: boolean;
  imageData?: string;
  answerImageData?: string | null;
  syllabusTopic?: string | null;
  // Master Class sub-topic tag (only present on mastery-quiz questions).
  // Used to group missed questions by sub-topic for the post-quiz
  // "review weak concepts" cards.
  subTopic?: string | null;
  // Quiz-specific transcription fields
  transcribedStem?: string | null;
  transcribedOptions?: string[] | null;
  transcribedOptionImages?: string[] | null;
  transcribedOptionTable?: { columns: string[]; rows: string[][] } | null;
  transcribedSubparts?: { label: string; text: string; refImageBase64?: string | null; diagramBase64?: string | null }[] | null;
  diagramImageData?: string | null;
}

interface BookletScore {
  label: string;
  awarded: number;
  available: number;
}

interface ReviewData {
  markingStatus: string | null;
  score: number | null;
  feedbackSummary: string | null;
  questions: ReviewQuestion[];
  bookletScores?: BookletScore[];
  // Parent's red-pen review annotations: keyed by 'passage:<sectionLabel>'
  // or 'question:<questionId>', value is a PNG data URL.
  reviewAnnotations?: Record<string, string> | null;
  // True when this paper was compiled by the "Revise Work" admin
  // tool. The review UI uses this to suppress the score ring (a
  // revision paper IS a curated set of past mistakes, so a 0% on
  // the ring is just demoralising).
  isRevision?: boolean;
}

export default function ExamReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <ExamReviewContent id={id} />
    </Suspense>
  );
}

function ExamReviewContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [paperTitle, setPaperTitle] = useState("");
  const [paperSubject, setPaperSubject] = useState<string | null>(null);
  const [totalMarks, setTotalMarks] = useState<string | null>(null);
  const [assignedToId, setAssignedToId] = useState<string | null>(null);
  const [answerPages, setAnswerPages] = useState<number[]>([]);
  const [skipPages, setSkipPages] = useState<number[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [submissionPageOverride, setSubmissionPageOverride] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [submissionPageCount, setSubmissionPageCount] = useState(0);
  const [elaborations, setElaborations] = useState<Record<string, string>>({});
  const [elabDiagrams, setElabDiagrams] = useState<Record<string, DiagramStep[]>>({});
  const [elaborating, setElaborating] = useState<string | null>(null);
  // Admin-only edit mode for the AI explanation card. Keyed by
  // question id; a non-undefined entry means "this question is in
  // edit mode" and holds the in-flight text the admin is typing.
  // Save sends the draft to PATCH /api/exam/[id]/elaborate; the
  // diagrams sidecar is preserved as-is (not edited inline).
  const [elabDraft, setElabDraft] = useState<Record<string, string>>({});
  const [elabSaving, setElabSaving] = useState<string | null>(null);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  // Flag-with-note flow: clicking the flag button on a NOT-yet-flagged
  // question opens FlagVoiceModal first (record / type / just-flag).
  // Clicking it on an already-flagged question unflags directly.
  const [flagModalQuestionId, setFlagModalQuestionId] = useState<string | null>(null);
  const [flagging, setFlagging] = useState<string | null>(null);
  const [instantFeedback, setInstantFeedback] = useState(false);
  const [isQuiz, setIsQuiz] = useState(false);
  const [paperType, setPaperType] = useState<string | null>(null);
  // Master Class metadata — populated only when paperType === "mastery".
  // masterClassSlug links back to /admin/master-class/<slug>; the
  // missed-sub-topic computation below derives weak areas from this.
  const [masterClassSlug, setMasterClassSlug] = useState<string | null>(null);
  const [masterClassTitle, setMasterClassTitle] = useState<string | null>(null);
  const [masteryQuizLaunching, setMasteryQuizLaunching] = useState(false);
  const [canvasHeights, setCanvasHeights] = useState<Record<string, number>>({});
  const [oeqPageMap, setOeqPageMap] = useState<Record<string, number> | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [englishSections, setEnglishSections] = useState<Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> | null>(null);
  const [expandedElabs, setExpandedElabs] = useState<Set<string>>(new Set());
  const [editingMarks, setEditingMarks] = useState<string | null>(null);
  const [savingMarks, setSavingMarks] = useState(false);
  const [remarking, setRemarking] = useState(false);
  const [advisoryDismissed, setAdvisoryDismissed] = useState(false);
  const [released, setReleased] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pendingReviewIds, setPendingReviewIds] = useState<string[]>([]);
  const [sticker, setSticker] = useState<string | null>(null);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const isDiagnostic = searchParams?.get("diagnostic") === "1";
  // Session-derived role flag. Defaults to false until /api/users/me
  // resolves; the URL ?userId= comparison falls back during that
  // window, which is safe (admin briefly sees student-view, then UI
  // flips to admin-view on hydrate).
  const [sessionIsAdminOrParent, setSessionIsAdminOrParent] = useState(false);
  // Strict-admin signal: gates affordances that should NEVER appear
  // for parents — e.g. editing the cached AI explanation text. Set
  // in the same /api/users/me effect below.
  const [sessionIsAdmin, setSessionIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Skip /api/users/me when there's no session presence flag — the
    // middleware would 401 it anyway. The route's own auth check
    // still fires for any client that did slip through; this is just
    // log-noise reduction.
    if (typeof document !== "undefined"
        && !/(?:^|; )yuna_session_present=1(?:;|$)/.test(document.cookie)) {
      return () => { cancelled = true; };
    }
    fetch("/api/users/me")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d?.user) return;
        // Admin always passes. Parents are detected via role=PARENT —
        // they should see Re-mark on their kids' quizzes too. Students
        // are the only role that should be locked into student-view.
        const u = d.user as { role?: string; isAdmin?: boolean };
        if (u.isAdmin || u.role === "PARENT") setSessionIsAdminOrParent(true);
        if (u.isAdmin) setSessionIsAdmin(true);
      })
      .catch(() => { /* non-fatal — falls back to URL-based detection */ });
    return () => { cancelled = true; };
  }, []);
  const diagnosticParentId = searchParams?.get("parentId") ?? "";
  const [showFirstQuizPopup, setShowFirstQuizPopup] = useState(false);
  // Show a one-time congratulations popup when the student lands on the review page from
  // their first diagnostic quiz (URL has ?diagnostic=1&parentId=...).
  useEffect(() => {
    if (!isDiagnostic || !data || !isQuiz) return;
    if (data.markingStatus !== "complete" && data.markingStatus !== "released") return;
    setShowFirstQuizPopup(true);
  }, [isDiagnostic, data, isQuiz]);

  // Fire a confetti + star volley once, when the student opens the review for
  // the first time with a final percentage ≥ 90%. Guarded in two places:
  //   * celebrationFiredRef — blocks re-firing within the same mount (e.g.
  //     parent mark edits re-triggering data).
  //   * localStorage mfy-celebration-shown-<paperId> — blocks replay across
  //     visits, so revisiting an old high-scoring quiz doesn't re-celebrate.
  const celebrationFiredRef = useRef(false);
  useEffect(() => {
    if (!data || celebrationFiredRef.current) return;
    if (data.markingStatus !== "complete" && data.markingStatus !== "released") return;
    if (typeof window === "undefined") return;
    const celebrationKey = `mfy-celebration-shown-${id}`;
    if (localStorage.getItem(celebrationKey)) return;
    const rawTotal = totalMarks ? Number(totalMarks) : null;
    if (!rawTotal || rawTotal <= 0) return;
    const skippedMarks = data.questions
      .filter(q => q.studentAnswer === "__SKIPPED__")
      .reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    const totalM = Math.max(0, rawTotal - skippedMarks);
    if (totalM <= 0) return;
    const pctValue = Math.min(100, Math.round(((data.score ?? 0) / totalM) * 100));
    if (pctValue < 90) return;
    celebrationFiredRef.current = true;
    localStorage.setItem(celebrationKey, "1");
    (async () => {
      // Slight celebratory haptic on mobile — a short pop for the main volley
      // and a two-tap burst when the stars fire. No-ops on iOS Safari / desktop.
      const buzz = (pattern: number | number[]) => {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try { navigator.vibrate(pattern); } catch { /* ignore */ }
        }
      };
      // Soft crowd cheer from /public/sounds/cheer.mp3 (or .ogg). If the file
      // is missing the load silently fails and we skip audio — so it's safe to
      // ship without the asset and drop it in later.
      try {
        const audio = new Audio("/sounds/cheer.mp3");
        audio.volume = 0.10;
        audio.play().catch(() => { /* browser blocked or file missing */ });
      } catch { /* ignore */ }
      try {
        const confetti = (await import("canvas-confetti")).default;
        buzz(60);
        confetti({
          particleCount: 120, spread: 80, startVelocity: 50,
          origin: { x: 0.5, y: 0.15 },
          colors: ["#6cf8bb", "#ffd700", "#ff6ec7", "#7fd1ff", "#a78bfa"],
        });
        setTimeout(() => {
          buzz([30, 50, 30]);
          confetti({
            particleCount: 40, spread: 70, startVelocity: 45,
            origin: { x: 0.1, y: 0.2 },
            shapes: ["star"], colors: ["#ffd700", "#fff4a3", "#ffb800"],
          });
          confetti({
            particleCount: 40, spread: 70, startVelocity: 45,
            origin: { x: 0.9, y: 0.2 },
            shapes: ["star"], colors: ["#ffd700", "#fff4a3", "#ffb800"],
          });
        }, 250);
      } catch { /* canvas-confetti optional */ }
    })();
  }, [data, totalMarks]);

  useEffect(() => {
    async function fetchData() {
      try {
        const [markRes, paperRes] = await Promise.all([
          fetch(`/api/exam/${id}/mark`),
          fetch(`/api/exam/${id}`),
        ]);
        // Build maps from paper questions (imageData + transcription data for quizzes)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let paperQuestionMap: Record<string, any> = {};
        let paperIsQuiz = false;
        // Hoisted so the markData merge below can attach this.
        let paperReviewAnnotations: Record<string, string> | null = null;
        if (paperRes.ok) {
          const paper = await paperRes.json();
          paperReviewAnnotations = (paper.reviewAnnotations as Record<string, string> | null) ?? null;
          setPaperTitle(paper.title ?? "");
          setPaperSubject(paper.subject ?? null);
          setTotalMarks(paper.totalMarks ?? null);
          setAssignedToId(paper.assignedToId ?? null);
          setInstantFeedback(paper.instantFeedback === true);
          paperIsQuiz = paper.paperType === "quiz" || paper.paperType === "focused" || paper.paperType === "mastery";
          setIsQuiz(paperIsQuiz);
          setPaperType(paper.paperType ?? null);
          if (paper.paperType === "mastery") {
            const meta = paper.metadata as { masterClassSlug?: string; masterClassTitle?: string } | null;
            setMasterClassSlug(meta?.masterClassSlug ?? null);
            setMasterClassTitle(meta?.masterClassTitle ?? null);
          }
          setAnswerPages(paper.metadata?.answerPages ?? []);
          setSkipPages(paper.metadata?.skipPages ?? []);
          if (paper.metadata?.englishSections) setEnglishSections(paper.metadata.englishSections);
          // Chinese sections feed the same review state as English —
          // both shapes are identical so the existing render path
          // works for either. Kept as a SEPARATE branch (not folded
          // into the English condition) so a future change to either
          // path doesn't accidentally affect the other.
          else {
            const chSecs = (paper.metadata as { chineseSections?: typeof paper.metadata.englishSections } | undefined)?.chineseSections;
            if (chSecs) setEnglishSections(chSecs);
          }
          if (paper.metadata?.sticker) setSticker(paper.metadata.sticker);
          if (paper.metadata?.canvasHeights) setCanvasHeights(paper.metadata.canvasHeights as Record<string, number>);
          if (paper.metadata?.oeqPageMap) setOeqPageMap(paper.metadata.oeqPageMap as Record<string, number>);
          setPageCount(paper.pageCount ?? 0);
          const ap = paper.metadata?.answerPages ?? [];
          const sp = paper.metadata?.skipPages ?? [];
          setSubmissionPageCount((paper.pageCount ?? 0) - ap.length - sp.length);
          // Map questionNum → full question data from paper
          for (const q of paper.questions ?? []) {
            if (q.questionNum) {
              paperQuestionMap[q.questionNum] = q;
            }
          }
        }
        if (markRes.ok) {
          const markData = await markRes.json();
          // Attach data from paper questions to mark data
          for (const q of markData.questions ?? []) {
            const pq = paperQuestionMap[q.questionNum];
            if (pq) {
              if (pq.imageData) q.imageData = pq.imageData;
              if (pq.answerImageData) q.answerImageData = pq.answerImageData;
              // For quizzes, also attach transcription data.
              // transcribedOptionTable was missing from this merge,
              // which is why table-format MCQ rendered the OEQ canvas
              // instead of the actual table — the DB row had it but
              // currentQ saw `null` after merge.
              if (paperIsQuiz) {
                q.transcribedStem = pq.transcribedStem ?? null;
                q.transcribedOptions = pq.transcribedOptions ?? null;
                q.transcribedOptionImages = pq.transcribedOptionImages ?? null;
                q.transcribedOptionTable = pq.transcribedOptionTable ?? null;
                q.transcribedSubparts = pq.transcribedSubparts ?? null;
                q.diagramImageData = pq.diagramImageData ?? null;
              }
            }
          }
          // mark route doesn't carry reviewAnnotations — pull from the
          // paper response so the overlay's initialDataUrl seeds correctly.
          markData.reviewAnnotations = paperReviewAnnotations;
          setData(markData);
          // Pre-populate cached elaborations and flagged state.
          // Cache value may be JSON ({solution, diagrams}) or legacy
          // plain text — parseElabCache returns the right shape either way.
          const cached: Record<string, string> = {};
          const cachedDiagrams: Record<string, DiagramStep[]> = {};
          const flagged = new Set<string>();
          for (const q of markData.questions ?? []) {
            if (q.elaboration) {
              const { text, diagrams } = parseElabCache(q.elaboration);
              cached[q.id] = text;
              if (diagrams.length > 0) cachedDiagrams[q.id] = diagrams;
            }
            if (q.flagged) flagged.add(q.id);
          }
          if (Object.keys(cached).length > 0) setElaborations(cached);
          if (Object.keys(cachedDiagrams).length > 0) setElabDiagrams(cachedDiagrams);
          if (flagged.size > 0) setFlaggedIds(flagged);

          // ── Auto-solve catch-all ─────────────────────────────────
          // For each question with sub-parts whose answer text
          // doesn't mention every sub-part label, fire the
          // auto-solve endpoint in the background. The endpoint is
          // idempotent (server runs the same check again) and
          // writes the labelled output back to the answer field,
          // so the renderer picks up (a)/(b)/(c) etc. without us
          // having to parse here.
          //
          // Loose check on purpose: a false positive just costs one
          // extra AI call.
          const needsSolve = (markData.questions ?? []).filter((q: ReviewQuestion) => {
            if (!q.transcribedSubparts) return false;
            const labels = q.transcribedSubparts
              .filter((s) => !s.label.startsWith("_"))
              .map((s) => s.label.toLowerCase());
            if (labels.length === 0) return false;
            const ans = (q.answer ?? "").toLowerCase();
            // True if at least one label is NOT mentioned anywhere in
            // the answer text. Accept any of the equivalent label
            // forms so hybrid answers don't falsely trigger:
            //   "(a)"       — plain
            //   "(a-i)"     — hyphen-compound storage shorthand
            //   "(a)(i)"    — paren-paren compound
            //   "a)"        — bare close-paren (very old extracts)
            //   "Na:"       — question-number prefix (e.g. "7a:")
            // Without these alternatives, a perfectly-good compound
            // answer like "(a-i) K (a)(ii) J | (b) ... | (c) ..."
            // re-triggered auto-solve and the AI wrote a steps-based
            // solution into the answer field, destroying the key.
            return labels.some((l) => {
              if (ans.includes(`(${l})`)) return false;
              if (ans.includes(`(${l}-`)) return false;
              // word-boundary "a)" — avoid matching the "a)" inside "(a)"
              if (new RegExp(`(^|[\\s|])${l}\\)`, "i").test(ans)) return false;
              if (new RegExp(`\\d+${l}[\\s:)]`, "i").test(ans)) return false;
              return true;
            });
          });
          // Fire-and-forget — limit concurrency a little so we don't
          // hammer Gemini if a parent opens a paper with 20 missing
          // questions at once. 3 in flight is plenty.
          (async () => {
            const queue = [...needsSolve];
            const workers = Array.from({ length: 3 }, async () => {
              while (queue.length > 0) {
                const q = queue.shift();
                if (!q) break;
                try {
                  const r = await fetch(`/api/exam/question/${q.id}/auto-solve`, { method: "POST" });
                  if (!r.ok) continue;
                  const data = (await r.json()) as { answer?: string };
                  if (!data.answer) continue;
                  setData((prev) => prev ? {
                    ...prev,
                    questions: prev.questions?.map((qq) => qq.id === q.id ? { ...qq, answer: data.answer ?? qq.answer } : qq),
                  } : prev);
                } catch {
                  /* ignore */
                }
              }
            });
            await Promise.all(workers);
          })();
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  // Auto-refresh while marking is still in progress. Native iOS has
  // no pull-to-refresh, so without this the page sits on
  // "marking…" forever even after the server has finished. Poll
  // every 5 s, stop as soon as we see complete/released or any
  // error state.
  useEffect(() => {
    const status = data?.markingStatus;
    if (!status || status === "complete" || status === "released") return;
    let cancelled = false;
    const tick = setInterval(async () => {
      try {
        const r = await fetch(`/api/exam/${id}/mark`);
        if (r.status === 401 || r.status === 403) {
          // Session expired (or tab left open across a logout). Stop
          // polling — otherwise this tab hammers /mark every 5s
          // forever and floods the middleware logs. The user can
          // refresh after re-login to resume.
          if (!cancelled) {
            cancelled = true;
            clearInterval(tick);
          }
          return;
        }
        if (!r.ok) return;
        const fresh = await r.json();
        if (fresh?.markingStatus === "complete" || fresh?.markingStatus === "released") {
          // Marking just finished — full reload picks up fresh
          // questions, marks, marking notes, elaboration cache,
          // etc. without us having to merge field-by-field.
          window.location.reload();
        }
      } catch { /* ignore — try again next tick */ }
    }, 5000);
    return () => clearInterval(tick);
  }, [id, data?.markingStatus]);

  // Reset the passage pen state when navigating between items (sections
  // or questions) so each new view starts with the pen off. Placed
  // before early returns to keep the hook order stable across renders.
  useEffect(() => { setPassagePenActive(false); }, [currentIdx]);

  // Fetch pending review papers for "Reviewed, next" button
  useEffect(() => {
    if (!assignedToId || !userId || userId === assignedToId) return; // only for parents
    fetch(`/api/exam?userId=${userId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.papers) return;
        // Find papers assigned to this student that are completed but not released
        const pending = (d.papers as Array<{ id: string; assignedToId: string; completedAt: string | null; markingStatus: string | null }>)
          .filter(p => p.assignedToId === assignedToId && p.completedAt && p.markingStatus === "complete")
          .map(p => p.id)
          .filter(pid => pid !== id); // exclude current
        setPendingReviewIds(pending);
      })
      .catch(() => {});
  }, [assignedToId, userId, id]);

  function getSubmissionPage(originalPageIdx: number): number {
    const hiddenSet = new Set([
      ...answerPages.map((p) => p - 1),
      ...skipPages.map((p) => p - 1),
    ]);
    let idx = 0;
    for (let i = 0; i < pageCount; i++) {
      if (!hiddenSet.has(i)) {
        if (i === originalPageIdx) return idx;
        idx++;
      }
    }
    return originalPageIdx;
  }

  async function handleRemark() {
    if (!confirm("Re-mark this paper? This will re-run AI marking on all questions and override any manual score changes.")) return;
    setRemarking(true);
    console.log(`[review] Re-mark requested for paper ${id}`);
    try {
      const res = await fetch(`/api/exam/${id}/mark`, { method: "POST" });
      console.log(`[review] Re-mark POST → status ${res.status}`);
      if (res.status === 401 || res.status === 403) {
        // Session expired in this tab. Friendlier than "HTTP 401".
        alert("Your session has expired. Please sign in again and retry the Re-mark.");
        setRemarking(false);
        router.push(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        alert(`Re-mark failed (HTTP ${res.status}): ${body || "no body"}`);
        setRemarking(false);
        return;
      }
      // Land parents on the selected-student progress view so they can see marking progress
      const isStudentSelf = userId === assignedToId;
      const target = assignedToId && !isStudentSelf
        ? `/home/${userId}?view=progress&student=${assignedToId}`
        : `/home/${userId}`;
      router.push(target);
    } catch (err) {
      console.error(`[review] Re-mark fetch threw`, err);
      alert(`Re-mark failed: ${err instanceof Error ? err.message : String(err)}`);
      setRemarking(false);
    }
  }

  async function handleRelease() {
    setReleasing(true);
    try {
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markingStatus: "released" }),
      });
      setReleased(true);
    } finally {
      setReleasing(false);
    }
  }

  async function saveSticker(stickerName: string) {
    setShowStickerPicker(false);
    setSticker(stickerName || null);
    try {
      const paperRes = await fetch(`/api/exam/${id}`);
      if (!paperRes.ok) return;
      const paperData = await paperRes.json();
      const meta = paperData.metadata ?? {};
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { ...meta, sticker: stickerName || null } }),
      });
    } catch (err) {
      console.error("Failed to save sticker:", err);
    }
  }

  async function fetchElaboration(questionId: string) {
    if (elaborations[questionId]) {
      // Already fetched — just expand
      setExpandedElabs(prev => new Set(prev).add(questionId));
      return;
    }
    setElaborating(questionId);
    try {
      const res = await fetch(`/api/exam/${id}/elaborate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId }),
      });
      if (res.ok) {
        const { elaboration, diagrams } = (await res.json()) as { elaboration: string; diagrams?: DiagramStep[] };
        setElaborations((prev) => ({ ...prev, [questionId]: elaboration }));
        if (Array.isArray(diagrams) && diagrams.length > 0) {
          setElabDiagrams((prev) => ({ ...prev, [questionId]: diagrams }));
        }
        // Auto-expand after fetch completes
        setExpandedElabs(prev => new Set(prev).add(questionId));
      }
    } catch {
      // ignore
    } finally {
      setElaborating(null);
    }
  }

  async function updateMarks(questionId: string, newMarks: number) {
    setSavingMarks(true);
    try {
      const res = await fetch(`/api/exam/questions/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marksAwarded: newMarks }),
      });
      if (res.ok) {
        setData((prev) => {
          if (!prev) return prev;
          const questions = prev.questions.map((q) =>
            q.id === questionId ? { ...q, marksAwarded: newMarks } : q
          );
          const newScore = questions.reduce((sum, q) => sum + (q.marksAwarded ?? 0), 0);
          return { ...prev, questions, score: newScore };
        });
      }
    } catch {
      // ignore
    } finally {
      setSavingMarks(false);
    }
  }

  async function toggleFlag(questionId: string, text?: string) {
    setFlagging(questionId);
    try {
      const res = await fetch(`/api/exam/${id}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, userId, text }),
      });
      if (res.ok) {
        const { flagged } = await res.json();
        setFlaggedIds((prev) => {
          const next = new Set(prev);
          if (flagged) next.add(questionId);
          else next.delete(questionId);
          return next;
        });
      }
    } catch {
      // ignore
    } finally {
      setFlagging(null);
    }
  }

  // Click handler for the flag button. If the question is currently
  // unflagged, prompt for an optional note via FlagVoiceModal first;
  // if it's already flagged, just unflag directly.
  function onFlagClick(questionId: string) {
    if (flaggedIds.has(questionId)) {
      void toggleFlag(questionId);
    } else {
      setFlagModalQuestionId(questionId);
    }
  }

  // isStudent looks at URL ?userId= vs the paper's assignedToId — when
  // an admin/parent opens /exam/{id}/review?userId={studentId} the URL
  // matches and the page would otherwise treat them as the student
  // (hiding Re-mark / Mark-as-Reviewed). Override with the SESSION
  // user's role: admin always gets the controls; parents linked to the
  // student do too.
  const isStudent = userId === assignedToId && !sessionIsAdminOrParent;
  // Hoisted toolbar state for the passage overlay — rendered next to
  // the section header instead of floating inside the passage box.
  // Resets on section change so each section starts with pen off.
  const [passagePenActive, setPassagePenActive] = useState(false);
  const [passagePenClearSignal, setPassagePenClearSignal] = useState(0);
  // After ReviewPenOverlay successfully PATCHes new annotation, update
  // local state so re-mounting the overlay (next/prev nav) seeds with
  // the just-drawn ink instead of the stale value from page load.
  const handlePenSaved = (key: string, dataUrl: string | null) => {
    setData((prev) => {
      if (!prev) return prev;
      const next = { ...((prev.reviewAnnotations ?? {}) as Record<string, string>) };
      if (dataUrl === null) delete next[key];
      else next[key] = dataUrl;
      return { ...prev, reviewAnnotations: next };
    });
  };
  // When a student goes back from a completed quiz, ferry the score into the
  // home URL so the experience bar can animate the points flowing in. The
  // student dashboard will replay the animation only once per paper (guarded
  // by localStorage), then strip the params.
  const canCelebrateBack = isStudent && isQuiz && (data?.markingStatus === "complete" || data?.markingStatus === "released") && (data?.score ?? 0) > 0;
  // Defensive fallback: if `userId` got dropped (e.g. iOS login flow
  // landed here without it), bounce to /login rather than build a
  // /home/ URL with an empty id, which 404s. The login page reads
  // the session cookie and redirects to the right home automatically.
  const backPath = !userId
    ? "/login"
    : assignedToId && !isStudent
      ? `/home/${userId}?view=progress&student=${assignedToId}`
      : canCelebrateBack
        ? `/home/${userId}?view=progress&newPoints=${data!.score}&fromPaper=${id}`
        : `/home/${userId}?view=progress`;

  if (loading) {
    return (
      <div className="flex justify-center py-24 bg-[#f8f9ff] min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-[#dce9ff] border-t-[#001e40]" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-[#43474f] mb-4">Could not load results.</p>
          <button onClick={() => { playClick(); router.replace(backPath); }} className="px-6 py-2.5 rounded-2xl bg-[#001e40] text-white font-bold text-sm">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  // Students can only see results once released (or instant feedback).
  // EXCEPTION: Chinese quizzes contain OEQ that goes through async AI
  // marking (markExamPaper); the `instantFeedback` shortcut would let
  // students peek at a half-marked paper before the OEQ scores land.
  // For Chinese, force the same "complete" gate as non-instant papers.
  const isChinesePaper = ((paperSubject ?? "").toLowerCase() === "chinese") || ((paperSubject ?? "").includes("华文"));
  const chineseGate = isChinesePaper && data.markingStatus !== "complete" && data.markingStatus !== "released";
  const englishGate = data.markingStatus !== "released" && !(instantFeedback && data.markingStatus === "complete") && !(isQuiz && instantFeedback);
  if (isStudent && (isChinesePaper ? chineseGate : englishGate)) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-[#43474f] mb-4">{isChinesePaper ? "批改中，请稍候…" : "Results are not available yet."}</p>
          <button onClick={() => { playClick(); router.replace(backPath); }} className="px-6 py-2.5 rounded-2xl bg-[#001e40] text-white font-bold text-sm">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  const writtenQuestions = isStudent && !isQuiz
    ? data.questions.filter((q) => q.marksAwarded !== null)
    : data.questions;

  const incorrectQuestions = writtenQuestions.filter((q) => {
    if (q.marksAwarded === null || q.marksAvailable === null) return false;
    return q.marksAwarded < q.marksAvailable;
  });

  // Build display items: collapse typed English sections into single entries
  type DisplayItem = { type: "question"; question: ReviewQuestion } | { type: "section"; section: typeof englishSections extends (infer T)[] | null ? NonNullable<T> : never; questions: ReviewQuestion[] };
  const baseQuestions = showAll ? writtenQuestions : incorrectQuestions;
  const displayItems: DisplayItem[] = [];
  const sectionQIds = new Set<string>();

  if (englishSections) {
    // Find which sections are typed (shown as a group)
    for (const sec of englishSections) {
      const label = sec.label.toLowerCase();
      // Chinese 华文 sections — `englishSections` doubles as the
      // chineseSections feed for Chinese papers (see useEffect that
      // populates the state). Detection has to match on the raw
      // (Chinese-character) label since toLowerCase() doesn't strip
      // Chinese chars. Without this, every Chinese section bypassed
      // the grouped layout and the review page rendered them as a
      // flat list of individual questions — no passage, no inline
      // pickers, no green/red.
      const rawLabel = sec.label;
      const isChineseGrouped =
        rawLabel.includes("短文填空") ||         // vocab cloze MCQ inline pickers
        rawLabel.includes("完成对话") || rawLabel.includes("对话填空") ||  // word-bank dialogue cloze
        rawLabel.includes("阅读理解");           // 阅读理解 MCQ / 阅读理解 A / 阅读理解 B OEQ
      const isGrouped = isChineseGrouped ||
        label.includes("grammar cloze") || label.includes("editing") ||
        label.includes("comprehension cloze") || (label.includes("comp") && label.includes("cloze")) ||
        label.includes("vocab cloze") || (label.includes("vocab") && label.includes("cloze")) ||
        label.includes("synthesis") || label.includes("comprehension oeq") || label.includes("comprehension open") ||
        // Visual Text: the poster/article image is the passage, shared across all
        // questions in the section. Grouping keeps the passage on top and lists
        // all answers below instead of repeating the image per question.
        (label.includes("visual") && label.includes("text"));
      if (isGrouped) {
        const secQs = data.questions.slice(sec.startIndex, sec.endIndex + 1);
        const hasRelevant = secQs.some(q => baseQuestions.some(bq => bq.id === q.id));
        if (hasRelevant) {
          displayItems.push({ type: "section", section: sec, questions: secQs });
          for (const q of secQs) sectionQIds.add(q.id);
        }
      }
    }
  }
  // Add individual questions that aren't part of grouped sections
  for (const q of baseQuestions) {
    if (!sectionQIds.has(q.id)) {
      displayItems.push({ type: "question", question: q });
    }
  }
  // Sort by first question's position in data.questions
  displayItems.sort((a, b) => {
    const aIdx = data.questions.findIndex(q => q.id === (a.type === "question" ? a.question.id : a.questions[0]?.id));
    const bIdx = data.questions.findIndex(q => q.id === (b.type === "question" ? b.question.id : b.questions[0]?.id));
    return aIdx - bIdx;
  });

  const currentItem = displayItems[currentIdx] ?? null;
  const currentQ = currentItem?.type === "question" ? currentItem.question : (currentItem?.type === "section" ? currentItem.questions[0] : null);

  // Detect if current item is a typed section
  const currentSection = currentItem?.type === "section" ? currentItem.section : null;
  const currentSectionLabel = currentSection?.label.toLowerCase() ?? "";
  const isTypedSection = currentItem?.type === "section";
  const sectionQuestions = currentItem?.type === "section" ? currentItem.questions : [];

  // For quiz OEQ: determine submission page index for the current question.
  // Prefer stored oeqPageMap (set at submission time) to avoid mismatches when
  // MCQ/OEQ classification logic changes between quiz-taking and review.
  const hasOpts = (q: ReviewQuestion) => (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) || (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(o => !!o)) || (!!q.transcribedOptionTable && Array.isArray(q.transcribedOptionTable.rows) && q.transcribedOptionTable.rows.length === 4);
  // Math/Science MCQ get the plain "Explanation" label (the elaboration
  // is admin-curated and lives on the master paper). Everything else
  // (English, OEQ on any subject) keeps "AI explanation" since those
  // explanations are generated on demand by the AI.
  const isMathOrScience = (() => {
    const s = (paperSubject ?? "").toLowerCase();
    return s.includes("math") || s.includes("science");
  })();
  const isMathSciMcq = (q: ReviewQuestion) => isMathOrScience && hasOpts(q);
  const allOeqQuestions = data.questions.filter(q => !hasOpts(q));
  const currentQOeqIndex = currentQ ? allOeqQuestions.findIndex(q => q.id === currentQ.id) : -1;
  // Use stored page map when available (set at submission time, immune to code changes).
  // Otherwise fall back to calculated OEQ index using current options-based classification.
  const currentQSubmissionPage = currentQ && oeqPageMap && currentQ.id in oeqPageMap
    ? oeqPageMap[currentQ.id]
    : currentQOeqIndex;

  const baseSubmissionPage = currentQ ? getSubmissionPage(currentQ.pageIndex) : 0;
  const effectiveSubmissionPage = submissionPageOverride ?? baseSubmissionPage;

  // Skipped questions still appear in review, but their marks are excluded from the denominator.
  const skippedQs = data.questions.filter(q => q.studentAnswer === "__SKIPPED__");
  const skippedMarks = skippedQs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
  const effectiveScore = (data.score ?? 0);
  const rawTotal = totalMarks ? Number(totalMarks) : null;
  const totalM = rawTotal !== null ? Math.max(0, rawTotal - skippedMarks) : null;
  // Only show a percentage once the paper has actually been marked. Otherwise
  // effectiveScore is 0, the ring renders 0% and the "Perfect score!" branch
  // (incorrectQuestions.length === 0) fires incorrectly for an unmarked paper.
  // Compiled "revise work" papers are a curated set of past mistakes;
  // any score is misleading (would always read 0–low%), so treat
  // them as if not yet marked for the score-ring purposes.
  const isMarked = !data.isRevision && (data.markingStatus === "complete" || data.markingStatus === "released");
  const pct = isMarked && totalM && totalM > 0 ? Math.min(100, Math.round((effectiveScore / totalM) * 100)) : null;
  const denominatorLabel = rawTotal !== null
    ? (skippedMarks > 0 ? `${rawTotal} − ${skippedMarks} skipped` : String(rawTotal))
    : "";
  // Compute weak topics: group by syllabusTopic, take topics with marks awarded < 60%, lowest 3.
  const weakTopics: string[] = (() => {
    const byTopic: Record<string, { awarded: number; available: number }> = {};
    for (const q of data.questions) {
      const topic = (q.syllabusTopic ?? "").trim();
      if (!topic) continue;
      if (q.studentAnswer === "__SKIPPED__") continue;
      const a = q.marksAvailable ?? 0;
      if (a <= 0) continue;
      if (!byTopic[topic]) byTopic[topic] = { awarded: 0, available: 0 };
      byTopic[topic].awarded += q.marksAwarded ?? 0;
      byTopic[topic].available += a;
    }
    return Object.entries(byTopic)
      .filter(([, v]) => v.available > 0 && v.awarded / v.available < 0.6)
      .sort((a, b) => (a[1].awarded / a[1].available) - (b[1].awarded / b[1].available))
      .slice(0, 3)
      .map(([t]) => t);
  })();
  // Friendly one-liner encouragement based on percentage. Revision
  // papers swap the score-pegged copy for plain "Revision set" so
  // there's still a useful header line.
  const encouragement = data.isRevision ? "Revision set"
    : !isMarked ? "Not marked yet"
    : pct === null ? "Keep going!"
    : pct >= 90 ? "Outstanding work!"
    : pct >= 80 ? "Excellent work!"
    : pct >= 70 ? "Great job!"
    : pct >= 60 ? "Good effort!"
    : pct >= 40 ? "Keep practising!"
    : "Don't give up — let's review!";
  const scoreBorderColor = pct === null ? "#d3e4fe"
    : pct >= 75 ? "#6cf8bb"
    : pct >= 50 ? "#ffb952"
    : "#ffdad6";
  const scoreTextColor = pct === null ? "#001e40"
    : pct >= 75 ? "#006c49"
    : pct >= 50 ? "#633f00"
    : "#ba1a1a";

  // Parse multi-part answer string by finding known subpart labels in the text
  function parsePartAnswers(text: string | null, knownLabels?: string[]): Record<string, string> {
    if (!text) return {};
    // Normalise the storage-shorthand compound form "(a-i)" / "(b-ii)"
    // back into "(a)(i)" / "(b)(ii)" so the label finder below sees the
    // OUTER "(a)" at the earliest position. Without this, a hybrid
    // answer like "(a-i) K (a)(ii) J | (b) ..." caused the label
    // finder to settle on the SECOND "(a)" inside "(a)(ii)", losing
    // the "(a-i) K" portion entirely from part (a)'s displayed answer.
    text = text.replace(/\(([a-z])-(i{1,4}|iv|v|vi{0,3})\)/gi, "($1)($2)");
    const lower = text.toLowerCase();
    const labels = knownLabels ?? ["a", "b", "c", "d", "e", "f"];

    // Find each label's position in the text
    const found: { label: string; start: number; matchStart: number }[] = [];
    for (const label of labels) {
      const lbl = label.toLowerCase();
      // Try patterns in order of specificity:
      // 1. "(label)"  e.g. "(a)"
      // 2. "label)"   e.g. "a)" — no opening paren
      // 3. "Nlabel:"  e.g. "36a:" — question-number prefixed
      // 4. bare complex labels like "a(i)"
      const bracketed = `(${lbl})`;
      let pos = lower.indexOf(bracketed);
      if (pos !== -1) {
        let end = pos + bracketed.length;
        // Compound form: "(a)(i) K (a)(ii) J ...". When the bracketed
        // label is immediately followed by another "(", treat it as a
        // compound — keep the outer "(a)" inside the content so the
        // rendered correct-answer block reads "(a)(i) K (a)(ii) J"
        // rather than just "(i) K (a)(ii) J".
        const isCompound = text[end] === "(";
        while (end < text.length && text[end] === " ") end++;
        found.push({ label: lbl, start: isCompound ? pos : end, matchStart: pos });
        continue;
      }
      // Try "label)" pattern at word boundary (e.g. "a) 3", "b) VW")
      const closeParenRe = new RegExp(`(?:^|[\\s|])${lbl}\\)\\s*`, "i");
      const closeMatch = lower.match(closeParenRe);
      if (closeMatch && closeMatch.index !== undefined) {
        const matchStart = closeMatch.index + (closeMatch[0].startsWith(lbl) ? 0 : 1);
        const end = closeMatch.index + closeMatch[0].length;
        found.push({ label: lbl, start: end, matchStart });
        continue;
      }
      // Try "Nlabel" pattern (e.g. "7a ", "36a:", "14b:")
      const numPrefixRe = new RegExp(`\\d+${lbl}[\\s:)]+`, "i");
      const numMatch = lower.match(numPrefixRe);
      if (numMatch && numMatch.index !== undefined) {
        const end = numMatch.index + numMatch[0].length;
        found.push({ label: lbl, start: end, matchStart: numMatch.index });
        continue;
      }
      // For complex labels like "a(i)", find them directly
      if (lbl.length > 1) {
        pos = lower.indexOf(lbl);
        if (pos !== -1) {
          let end = pos + lbl.length;
          while (end < text.length && text[end] === " ") end++;
          found.push({ label: lbl, start: end, matchStart: pos });
        }
      }
    }

    if (found.length === 0) {
      // No labelled parts found at all — if there's exactly one known label
      // and the text is non-empty, assign the entire text to that label.
      // This handles standalone answers like "50 cm" for a merged (c) part.
      if (knownLabels && knownLabels.length === 1 && text.trim()) {
        return { [knownLabels[0].toLowerCase()]: text.trim() };
      }
      return {};
    }
    found.sort((a, b) => a.matchStart - b.matchStart);

    const parts: Record<string, string> = {};

    // Text BEFORE the first found label may belong to a missing earlier label.
    // E.g. answer = "The frictional force... | (b) Cause: Plastic..."
    //   with labels [a,b] — text before (b) is part (a)'s answer.
    if (knownLabels && found.length > 0) {
      const beforeFirst = text.slice(0, found[0].matchStart).trim();
      if (beforeFirst) {
        const earlierMissing = knownLabels
          .map(l => l.toLowerCase())
          .filter(l => !found.some(f => f.label === l) && l < found[0].label);
        if (earlierMissing.length === 1) {
          parts[earlierMissing[0]] = beforeFirst;
        }
      }
    }

    for (let i = 0; i < found.length; i++) {
      const end = i + 1 < found.length ? found[i + 1].matchStart : text.length;
      let segment = text.slice(found[i].start, end).trim();
      // The slice runs up to the position of the NEXT label, but
      // the AI often writes a prelude like "Working for (b): ..." or
      // "Steps for (b): ..." right before the label. That prelude
      // belongs to the NEXT part, not this one — trim it off so
      // part (a)'s detected/correct answer doesn't appear cut off
      // at "Working for" (which is the start of part (b)'s header).
      segment = segment
        .replace(/[\s.,;|—-]*(?:working|steps?|solution|reasoning)\s*(?:for|:)?\s*$/i, "")
        .replace(/[\s.,;|—-]+$/g, "")
        .trim();
      parts[found[i].label] = segment;
    }

    // Text AFTER the last found label may contain answers for missing later labels.
    // E.g. answer = "(a) 12 (b) 25\n50 cm" with labels [a,b,c]:
    //   "50 cm" after newline is part (c)'s answer.
    if (knownLabels) {
      const missing = knownLabels.map(l => l.toLowerCase()).filter(l => !(l in parts));
      if (missing.length > 0 && found.length > 0) {
        const lastLabel = found[found.length - 1].label;
        const lastVal = parts[lastLabel] ?? "";
        const lines = lastVal.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length > 1 && lines.length - 1 >= missing.length) {
          parts[lastLabel] = lines[0];
          for (let m = 0; m < missing.length && m + 1 < lines.length; m++) {
            parts[missing[m]] = lines[m + 1];
          }
        }
      }
    }

    return parts;
  }

  function renderWithNewlines(text: string) {
    return text.split("|").map((part, i, arr) => (
      <span key={i}>
        <MathText text={part.trim()} />
        {i < arr.length - 1 ? <br /> : null}
      </span>
    ));
  }

  // Strip the AI's "Working: …" / "blank" scaffolding from a
  // detected-answer string so the parent doesn't see the literal
  // word "blank" leaking into the rendered Detected Answer card.
  // Handles:
  //   "Working: blank\nFinal answer: 24" → "Final answer: 24"
  //   "blank | Final answer: 24"         → "Final answer: 24"
  //   "blank"                             → "(no answer detected)"
  //   leading "Working: …" alone         → strip the prefix
  function cleanDetectedAnswer(raw: string): string {
    let s = raw.trim();
    // Drop a leading "Working:" / "Working" label (with or without colon).
    s = s.replace(/^\s*working\s*:?\s*/i, "");
    // Strip the AI's markdown scaffolding when it wraps the raw
    // transcription in **Part (a)** / **Transcription** / fenced
    // code blocks (newer Phase-1 prompt outputs do this for OEQ).
    // The labels are presentation noise; only the wrapped content
    // is the student's actual answer.
    s = s
      .replace(/\*\*\s*Part\s*\(?[A-Za-z0-9]+\)?\s*\*\*\s*\n?/gi, "")
      .replace(/\*\*\s*(?:Transcription|Transcript|OCR|Detected)\s*\*\*\s*\n?/gi, "")
      .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    // Drop a "blank" or "(blank)" line (or pipe-separated chunk) anywhere.
    let lines = s
      .split(/\r?\n|\s*\|\s*/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^\(?blank\)?$/i.test(line) && !/^no\s+answer$/i.test(line));
    // Science OEQ: drop empty-working scaffold lines like
    // "Working: (no working shown)" / "(a) Working: blank". For
    // short-answer science the working line is pure noise — the
    // AI emits it verbatim from its detection template. Math
    // keeps it because parents use the "no working shown" signal
    // when discussing method marks with the child.
    const isScience = (paperSubject ?? "").toLowerCase().includes("science");
    if (isScience) {
      const emptyWorkingRe = /^(?:\([a-z0-9]+\)\s*)?working\s*:?\s*\(?\s*(?:no\s+working(?:\s+shown)?|blank|empty|no\s+answer|nothing|none)\s*\)?\s*$/i;
      lines = lines.filter(l => !emptyWorkingRe.test(l));
    }
    // Dedup adjacent lines whose CONTENT (after stripping a
    // "Working:" / "Final answer:" / "(a) Working:" label) is
    // identical. Fixes the OEQ duplication where the AI emits
    // "Working: X" immediately followed by "Final answer: X"
    // with the same X — the detected answer card was showing
    // the same sentence twice joined together.
    const contentOnly = (l: string) =>
      l.replace(/^\s*(?:\([a-z0-9]+\)\s*)?(?:working|final\s+answer)\s*:?\s*/i, "").trim().toLowerCase();
    const deduped: string[] = [];
    for (const l of lines) {
      const key = contentOnly(l);
      const lastKey = deduped.length ? contentOnly(deduped[deduped.length - 1]) : "";
      if (key && key === lastKey) continue;
      deduped.push(l);
    }
    return deduped.join("\n").trim() || "(no answer detected)";
  }

  // Renders marking notes: bolds verdict labels and **keyword**
  // markers, and runs plain-text segments through MathText so
  // inline LaTeX (e.g. "$\frac{7}{27}$") renders as a proper
  // stacked fraction instead of leaking the dollar-sign syntax.
  // Science papers (especially circuit / shading / drawable diagram
  // questions) often have "Working: (no working shown)" lines inside
  // markingNotes that aren't useful — the answer IS the drawing.
  // Strip them before any display path. Pipes are the section
  // separator the marker uses (Detected: ... | Evidence ... |
  // Part (a) ...), so we clean per-pipe-segment and per-newline.
  function stripScienceNoise(text: string): string {
    const isScience = (paperSubject ?? "").toLowerCase().includes("science");
    if (!isScience) return text;
    const emptyWorkingLineRe = /(?:^|\n)\s*(?:\([a-z0-9]+\)\s*)?working\s*:?\s*\(?\s*(?:no\s+working(?:\s+shown)?|blank|empty|no\s+answer|nothing|none)\s*\)?\s*(?=\n|$)/gi;
    // Also strip the inline form "(a) Working: (no working shown)\n"
    // where the line starts with a subpart label and the working
    // scaffold is glued onto it.
    const inlineWorkingRe = /\((?:[a-z0-9]+)\)\s*working\s*:?\s*\(?\s*no\s+working(?:\s+shown)?\s*\)?\s*\n?/gi;
    let out = text
      .replace(emptyWorkingLineRe, "")
      .replace(inlineWorkingRe, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s*\|\s*\|/g, " | ")
      .trim();
    // Detected: prefix on a science drawable question is redundant —
    // the per-subpart detected-answer card already shows what the
    // student drew. Strip the leading "Detected: …" up to the first
    // " | " if there is one.
    out = out.replace(/^Detected:\s*[\s\S]*?\s\|\s*/i, "");
    return out;
  }
  function renderMarkingNotes(text: string) {
    text = stripScienceNoise(text);
    // Drop the 'Detected: …' segment — the student's detected answer
    // already gets its own 'Detected Answer' card above the marking
    // notes. Repeating it here is just noise.
    const parts = text
      .split("|")
      .map(p => p.trim())
      .filter(p => p && !/^detected\s*:/i.test(p));
    return parts.map((trimmed, i, arr) => {
      const boldRe = /(\*\*[^*\n]+\*\*|\([a-zA-Z]\)\s+(?:Partially\s+)?(?:Correct|Incorrect))/gi;
      const segments: React.ReactNode[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = boldRe.exec(trimmed)) !== null) {
        if (m.index > last) {
          segments.push(<MathText key={`t-${last}`} text={trimmed.slice(last, m.index)} />);
        }
        const raw = m[1];
        const label = raw.startsWith("**") ? raw.slice(2, -2) : raw;
        segments.push(<strong key={`b-${m.index}`}>{label}</strong>);
        last = m.index + raw.length;
      }
      if (last < trimmed.length) {
        segments.push(<MathText key={`t-${last}`} text={trimmed.slice(last)} />);
      }
      return (
        <span key={i}>
          {segments.length > 0 ? segments : <MathText text={trimmed} />}
          {i < arr.length - 1 ? <br /> : null}
        </span>
      );
    });
  }

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      {/* First-quiz congratulations popup — shown when the student lands here from the diagnostic flow */}
      {showFirstQuizPopup && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4"
          onClick={() => setShowFirstQuizPopup(false)}
        >
          <div
            className="bg-white rounded-3xl max-w-md w-full p-8 shadow-2xl text-center animate-[popIn_0.5s_cubic-bezier(0.34,1.56,0.64,1)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-20 h-20 rounded-full bg-[#6cf8bb]/30 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-4xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>celebration</span>
            </div>
            <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-3">Congratulations on finishing your first quiz!</h2>
            <p className="text-sm text-[#43474f] leading-relaxed mb-6">
              With each quiz, the AI gets smarter in identifying weak areas. You can build <strong className="font-bold text-[#001e40]">focused practices</strong> for those. Click &ldquo;Open parent homepage&rdquo; when you are done reviewing this quiz with your student.
            </p>
            <button
              onClick={() => setShowFirstQuizPopup(false)}
              className="px-8 py-3 rounded-2xl bg-[#001e40] text-white font-bold hover:bg-[#003366] transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ── Top bar ── */}
      <header className="fixed top-0 w-full z-50 bg-[#f8f9ff] backdrop-blur-xl shadow-sm">
        {/* Mobile: centered title */}
        <div className="lg:hidden flex items-center justify-between px-4 h-16">
          <button
            onClick={() => { playClick(); router.replace(backPath); }}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[#eff4ff] transition-colors"
          >
            <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
          </button>
          <h1 className="font-headline font-bold text-lg text-[#001e40]">{isQuiz ? "Quiz Review" : "Exam Review"}</h1>
          <div className="w-10" />
        </div>
        {/* Desktop: left-aligned with title + download */}
        <div className="hidden lg:flex items-center justify-between px-8 py-3 max-w-5xl mx-auto">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => { playClick(); router.replace(backPath); }}
              className="p-2 rounded-xl text-[#43474f] hover:bg-[#eff4ff] transition-colors shrink-0"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <p className="font-headline font-bold text-[#001e40] truncate">{paperTitle}</p>
          </div>
          <div className="flex items-center gap-3" />
        </div>
      </header>

      <div className="pt-16 pb-24 max-w-5xl mx-auto px-4 lg:px-8 relative">

        {/* ── Mastery Quiz panel ──
            Renders only for paperType === "mastery". Shows a result
            card on top:
              • full marks → "Congrats! Try another quiz" button
              • not full marks → "Let's review [weak concepts]" with a
                button that links to the Master Class workshop, filtered
                to the weak sub-topics' slides.
            Plus a "Back to Master Class" pill always. */}
        {paperType === "mastery" && masterClassSlug && isMarked && (() => {
          // Group misses by subTopic. Marks lost = (available − awarded)
          // for questions where awarded < available. Top 3 weakest.
          const byTopic = new Map<string, { label: string; lost: number; total: number }>();
          for (const q of data.questions) {
            const tag = (q.subTopic ?? "").trim();
            if (!tag) continue;
            const lost = Math.max(0, (q.marksAvailable ?? 0) - (q.marksAwarded ?? 0));
            const total = q.marksAvailable ?? 0;
            if (!byTopic.has(tag)) byTopic.set(tag, { label: tag, lost: 0, total: 0 });
            const e = byTopic.get(tag)!;
            e.lost += lost;
            e.total += total;
          }
          const weakRanked = [...byTopic.entries()]
            .filter(([, v]) => v.lost > 0)
            .sort((a, b) => b[1].lost - a[1].lost)
            .slice(0, 3);
          // Real full-marks check: every question scored full marks,
          // regardless of whether it was sub-topic tagged. Previously
          // we used weakRanked.length === 0 which only counted losses
          // on TAGGED questions — students who got an untagged
          // question wrong (e.g. a grammar MCQ in the "other" bucket
          // of the classifier) were falsely shown "Full marks".
          const totalAwarded = data.questions.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
          const totalAvailable = data.questions.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
          const fullMarks = totalAvailable > 0 && totalAwarded >= totalAvailable;
          // Pretty label lookup — keep it simple: kebab-case → Title Case.
          const prettify = (id: string) =>
            id.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

          async function tryAnotherQuiz() {
            if (!assignedToId) return;
            setMasteryQuizLaunching(true);
            try {
              const res = await fetch(`/api/master-class/${masterClassSlug}/start-quiz`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ studentId: assignedToId, parentMasteryId: id }),
              });
              const d = await res.json();
              if (res.ok) router.push(`/quiz/${d.paperId}?userId=${assignedToId}`);
            } finally {
              setMasteryQuizLaunching(false);
            }
          }

          function reviewWeakSlides() {
            const focus = weakRanked.map(([k]) => k).join(",");
            // Students land on the public master class page (not the
            // admin one) — admins can still use the admin route via
            // their nav. The /admin/* route is gated by isAdmin and
            // 403s for everyone else.
            router.push(`/master-class/${masterClassSlug}?userId=${userId}&focus=${focus}`);
          }

          return (
            <section className="mt-5 mb-5">
              <div className={`rounded-2xl p-5 lg:p-6 shadow-sm ring-1 ${fullMarks ? "bg-gradient-to-br from-emerald-50 to-sky-50 ring-emerald-200" : "bg-gradient-to-br from-amber-50 to-rose-50 ring-amber-200"}`}>
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                    Mastery Quiz · {masterClassTitle ?? "Master Class"}
                  </p>
                  <button
                    onClick={() => router.push(`/master-class/${masterClassSlug}?userId=${userId}`)}
                    className="text-[11px] font-bold text-slate-700 hover:text-slate-900 underline"
                  >
                    ← Back to Master Class
                  </button>
                </div>
                {fullMarks ? (
                  <>
                    <h2 className="text-xl lg:text-2xl font-extrabold text-emerald-900">🎉 Congrats! Full marks.</h2>
                    <p className="text-sm text-emerald-800 mt-1">Want to try another quiz to make sure you have mastered the concepts?</p>
                    <button
                      onClick={tryAnotherQuiz}
                      disabled={masteryQuizLaunching || !assignedToId}
                      className="mt-4 px-5 py-2.5 rounded-2xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:bg-slate-300"
                    >
                      {masteryQuizLaunching ? "Spawning next quiz…" : "Try another quiz →"}
                    </button>
                  </>
                ) : (
                  <>
                    <h2 className="text-xl lg:text-2xl font-extrabold text-amber-900">Great job!</h2>
                    {weakRanked.length > 0 ? (
                      <>
                        <p className="text-sm text-amber-900 mt-1">
                          Let&apos;s review {weakRanked.map(([, v], i) => (
                            <span key={v.label}>
                              <strong className="font-bold">{prettify(v.label)}</strong>
                              {i < weakRanked.length - 1 ? (i === weakRanked.length - 2 ? " and " : ", ") : ""}
                            </span>
                          ))} again. I&apos;ll bring you back to just those slides.
                        </p>
                        <button
                          onClick={reviewWeakSlides}
                          className="mt-4 px-5 py-2.5 rounded-2xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700"
                        >
                          Re-watch these concepts →
                        </button>
                      </>
                    ) : (
                      // Marks lost on untagged questions only — no specific
                      // sub-topic to point at. Show a generic next-quiz prompt
                      // so the student can keep practising.
                      <>
                        <p className="text-sm text-amber-900 mt-1">
                          You scored {totalAvailable > 0 ? Math.round((totalAwarded / totalAvailable) * 100) : 0}% on this quiz. Want to try another one to push toward full marks?
                        </p>
                        <button
                          onClick={tryAnotherQuiz}
                          disabled={masteryQuizLaunching || !assignedToId}
                          className="mt-4 px-5 py-2.5 rounded-2xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 disabled:bg-slate-300"
                        >
                          {masteryQuizLaunching ? "Spawning next quiz…" : "Try another quiz →"}
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </section>
          );
        })()}

        {/* ── Hero Score Section ── */}
        {/* Mobile: compact single card */}
        <section className="mt-5 mb-5 lg:hidden">
          <div className="bg-white rounded-2xl p-5 shadow-sm relative overflow-hidden">
            <div className="absolute -top-4 -right-4 w-24 h-24 bg-[#003366]/5 rounded-full blur-2xl" />
            <div className="flex items-center gap-5">
              {/* Circular progress ring */}
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center shrink-0"
                style={{
                  background: `radial-gradient(closest-side, white 78%, transparent 0% 100%), conic-gradient(${scoreBorderColor} ${pct ?? 0}%, #dce9ff 0)`,
                }}
              >
                <span className="font-headline font-extrabold text-xl" style={{ color: scoreTextColor }}>
                  {pct !== null ? `${pct}%` : isMarked ? `${data.score ?? 0}` : "—"}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-headline font-bold text-xl text-[#001e40]">
                  {pct !== null ? `${pct}% ${encouragement}` : encouragement}
                </h2>
                {weakTopics.length > 0 && (
                  <>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mt-2 mb-1">Weak areas identified</p>
                    <div className="flex gap-1.5 flex-wrap">
                      {weakTopics.map(t => (
                        <span key={t} className="px-2.5 py-0.5 bg-[#ffdad6] rounded-full text-[10px] font-bold text-[#ba1a1a]">{t}</span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            {/* Sticker top-right corner */}
            {sticker && (
              <div className="absolute top-3 right-3 z-10 group-open:hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/stickers/${sticker}`} alt="Sticker" className="w-20 h-20 object-contain drop-shadow-md" />
              </div>
            )}
            {/* Detailed AI summary tucked away — keeps the panel simple */}
            {data.feedbackSummary && (
              <details className="mt-3">
                <summary className="text-[10px] font-semibold text-[#43474f]/70 uppercase tracking-wide cursor-pointer select-none">More details</summary>
                <p className="text-xs text-[#43474f] leading-relaxed whitespace-pre-line mt-2 max-h-32 overflow-y-auto">{data.feedbackSummary}</p>
              </details>
            )}
            {/* Sticker button */}
            {!isStudent && (
              <div className="mt-3 relative">
                {!sticker ? (
                  <>
                    <button onClick={() => setShowStickerPicker(!showStickerPicker)} className="flex items-center gap-1.5 text-xs font-bold text-[#291800] bg-[#ffddb4] px-3 py-1.5 rounded-full hover:bg-[#ffcf94] transition-colors">
                      <span className="material-symbols-outlined text-sm">add_reaction</span>Add Sticker
                    </button>
                    {/* picker rendered as global modal below */}
                  </>
                ) : (
                  <button onClick={() => saveSticker("")} className="flex items-center gap-1 text-[10px] font-medium text-[#43474f] hover:text-[#ba1a1a] transition-colors">
                    <span className="material-symbols-outlined text-xs">close</span>Remove Sticker
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Desktop: bento grid */}
        <section className="hidden lg:grid grid-cols-3 gap-6 my-10">
          <div className="col-span-2 bg-white rounded-3xl p-8 flex flex-row items-center gap-8 relative overflow-hidden shadow-sm">
            <div className="absolute top-0 right-0 w-64 h-64 bg-[#6cf8bb]/10 rounded-full -mr-20 -mt-20 blur-3xl" />
            {sticker && (
              <div className="absolute top-4 right-4 z-20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/stickers/${sticker}`} alt="Sticker" className="w-36 h-36 object-contain drop-shadow-lg" />
              </div>
            )}
            <div
              className="relative z-10 flex flex-col items-center justify-center w-44 h-44 rounded-full shrink-0"
              style={{ background: `radial-gradient(closest-side, white 82%, transparent 82%), conic-gradient(${scoreBorderColor} ${pct ?? 0}%, #dce9ff 0)` }}
            >
              <span className="font-headline text-5xl font-extrabold" style={{ color: scoreTextColor }}>
                {pct !== null ? `${pct}%` : isMarked ? `${data.score ?? 0}` : "—"}
              </span>
              <span className="text-xs font-medium text-[#43474f] mt-1">
                {pct !== null ? `${data.score ?? 0} / ${denominatorLabel}` : isMarked ? "Score" : "Not marked"}
              </span>
            </div>
            <div className="flex-1">
              <h1 className="font-headline text-3xl font-extrabold text-[#001e40] mb-2">
                {pct !== null ? `${pct}% ${encouragement}` : encouragement}
              </h1>
              {weakTopics.length > 0 && (
                <div className="mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mb-1.5">Weak areas identified</p>
                  <div className="flex gap-2 flex-wrap">
                    {weakTopics.map(t => (
                      <span key={t} className="px-3 py-1 bg-[#ffdad6] rounded-full text-xs font-bold text-[#ba1a1a]">{t}</span>
                    ))}
                  </div>
                </div>
              )}
              {data.feedbackSummary && (
                <details className="mb-4">
                  <summary className="text-[10px] font-semibold text-[#43474f]/70 uppercase tracking-wide cursor-pointer hover:text-[#001e40] select-none">More details</summary>
                  <p className="text-sm text-[#43474f] leading-relaxed whitespace-pre-line mt-2 max-h-32 overflow-y-auto">{data.feedbackSummary}</p>
                </details>
              )}
              {data.bookletScores && data.bookletScores.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {data.bookletScores.map((b) => (
                    <span key={b.label} className="px-3 py-1 bg-[#eff4ff] rounded-full text-xs font-bold text-[#001e40]">
                      {b.label}: {b.awarded}/{b.available}
                    </span>
                  ))}
                </div>
              )}
              {/* Sticker button (parent) */}
              {!isStudent && (
                <div className="mt-3 relative">
                  {!sticker ? (
                    <>
                      <button onClick={() => setShowStickerPicker(!showStickerPicker)} className="flex items-center gap-1.5 text-xs font-bold text-[#291800] bg-[#ffddb4] px-3 py-1.5 rounded-full hover:bg-[#ffcf94] transition-colors">
                        <span className="material-symbols-outlined text-sm">add_reaction</span>Add Sticker
                      </button>
                      {/* picker rendered as global modal below */}
                    </>
                  ) : (
                    <button onClick={() => saveSticker("")} className="flex items-center gap-1 text-[10px] font-medium text-[#43474f] hover:text-[#ba1a1a] transition-colors">
                      <span className="material-symbols-outlined text-xs">close</span>Remove Sticker
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div className="bg-white rounded-3xl p-5 flex items-center gap-4 shadow-sm flex-1">
              <div className="w-12 h-12 rounded-2xl bg-[#eff4ff] flex items-center justify-center text-[#001e40] shrink-0">
                <span className="material-symbols-outlined">quiz</span>
              </div>
              <div>
                <p className="text-[10px] text-[#43474f] uppercase tracking-wider font-bold">{data.isRevision ? "Mistakes" : "Questions"}</p>
                {/* Revision papers pad passage sections with right-
                    answered companions so the cloze renderer can
                    fill every blank — the parent doesn't care that
                    we added 270 extra rows behind the scenes; the
                    meaningful number is the original mistake count
                    (= incorrect questions in the compiled paper).
                    Showing 328 / 100 was confusing because both
                    over-counted what the parent actually asked for. */}
                <p className="font-headline text-xl font-bold text-[#001e40]">{data.isRevision ? incorrectQuestions.length : writtenQuestions.length}</p>
              </div>
            </div>
            <div className="bg-white rounded-3xl p-5 flex items-center gap-4 shadow-sm flex-1">
              <div className="w-12 h-12 rounded-2xl bg-[#ffdad6] flex items-center justify-center text-[#ba1a1a] shrink-0">
                <span className="material-symbols-outlined">cancel</span>
              </div>
              <div>
                <p className="text-[10px] text-[#43474f] uppercase tracking-wider font-bold">To Review</p>
                <p className="font-headline text-xl font-bold text-[#ba1a1a]">{incorrectQuestions.length}</p>
              </div>
            </div>
            {/* Diagnostic flow only — open parent homepage in a new tab */}
            {isDiagnostic && diagnosticParentId && (
              <button
                onClick={() => window.open(`/home/${diagnosticParentId}?diagnosticWelcome=1`, "_blank")}
                className="bg-[#003366] text-white rounded-3xl p-5 flex items-center justify-center gap-3 shadow-md hover:bg-[#001e40] transition-colors font-bold text-sm"
              >
                <span className="material-symbols-outlined">open_in_new</span>
                Open parent homepage
              </button>
            )}
          </div>
        </section>

        {/* Mobile-only diagnostic CTA — same intent, sits below the score card */}
        {isDiagnostic && diagnosticParentId && (
          <button
            onClick={() => window.open(`/home/${diagnosticParentId}?diagnosticWelcome=1`, "_blank")}
            className="lg:hidden w-full bg-[#003366] text-white rounded-2xl p-4 flex items-center justify-center gap-2 shadow-md hover:bg-[#001e40] transition-colors font-bold text-sm mb-5"
          >
            <span className="material-symbols-outlined text-base">open_in_new</span>
            Open parent homepage
          </button>
        )}

        {/* Advisory — parents only */}
        {!isStudent && !advisoryDismissed && (
          <div className="rounded-2xl bg-blue-50 border border-blue-200 px-4 py-3 mb-6 flex items-start gap-3">
            <span className="material-symbols-outlined text-blue-600 shrink-0 mt-0.5">info</span>
            <p className="text-sm text-blue-700 leading-relaxed flex-1">
              We encourage you to review your child&apos;s mistakes together and discuss the correct approach.
            </p>
            <button onClick={() => setAdvisoryDismissed(true)} className="shrink-0 text-blue-400 hover:text-blue-600 transition-colors">
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
        )}

        {/* Remark button — parents, or anyone for English quizzes.
            flex-wrap + min-w-0 so on narrow phones (iOS) the buttons
            stack instead of overflowing off the left edge —
            previously "Mark as Reviewed" got pushed past the screen
            boundary on small viewports. */}
        {(!isStudent || englishSections) && (
          <div className="mb-4 flex flex-wrap justify-end items-center gap-2 min-w-0">
            {!isStudent && !released && (
              <>
                <button
                  onClick={handleRelease}
                  disabled={releasing}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-[#006c49] text-[#006c49] text-sm font-bold hover:bg-[#006c49]/10 transition-all disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-base">check_circle</span>
                  {releasing ? "Saving…" : "Mark as Reviewed"}
                </button>
                {pendingReviewIds.length > 0 && (
                  <button
                    onClick={async () => {
                      setReleasing(true);
                      try {
                        // 1) Mark current paper as released.
                        await fetch(`/api/exam/${id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ markingStatus: "released" }),
                        });
                        // 2) Re-fetch the pending list. Cached
                        //    pendingReviewIds was built on mount —
                        //    other tabs / earlier reviews may have
                        //    released some, leaving stale entries.
                        //    Picking the first stale id sent the
                        //    parent to an already-reviewed paper.
                        let nextId: string | null = null;
                        try {
                          const r = await fetch(`/api/exam?userId=${userId}`);
                          if (r.ok) {
                            const d = (await r.json()) as { papers: Array<{ id: string; assignedToId: string; completedAt: string | null; markingStatus: string | null }> };
                            const fresh = (d.papers ?? [])
                              .filter((p) => p.assignedToId === assignedToId && p.completedAt && p.markingStatus === "complete")
                              .map((p) => p.id)
                              .filter((pid) => pid !== id);
                            nextId = fresh[0] ?? null;
                          }
                        } catch { /* fall through to cached */ }
                        // Final fallback: use the originally-cached
                        // first id only if we couldn't refetch.
                        const target = nextId ?? pendingReviewIds[0];
                        if (target) {
                          router.push(`/exam/${target}/review?userId=${userId}`);
                        } else {
                          // No pending left — go home.
                          router.push(`/home/${userId}?view=progress&student=${assignedToId}`);
                        }
                      } catch {
                        setReleasing(false);
                      }
                    }}
                    disabled={releasing}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#006c49] text-white text-sm font-bold hover:bg-[#004d35] transition-all disabled:opacity-50"
                  >
                    Reviewed, next
                    <span className="material-symbols-outlined text-base">arrow_forward</span>
                  </button>
                )}
              </>
            )}
            {released && !isStudent && (
              <span className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-[#006c49]">
                <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>Reviewed
              </span>
            )}
            <button
              onClick={handleRemark}
              disabled={remarking}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-[#c3c6d1]/30 text-sm font-bold text-[#43474f] hover:bg-[#eff4ff] hover:text-[#001e40] transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-base">refresh</span>
              {remarking ? "Re-marking…" : englishSections ? "Re-mark All" : "Re-mark"}
            </button>
            {!isStudent && (paperType === null || paperType === "diagnostic") && (data.markingStatus === "complete" || data.markingStatus === "released") ? (
              <button
                onClick={async () => {
                  if (exporting) return;
                  setExporting(true);
                  try {
                    const r = await fetch(`/api/exam/${id}/export-marked?userId=${userId}`);
                    if (!r.ok) {
                      const detail = await r.json().catch(() => ({}));
                      alert(`Export failed: ${detail.detail ?? r.status}`);
                      return;
                    }
                    const blob = await r.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    // Server sets a Content-Disposition with the proper title
                    // already; this fallback name only kicks in if the browser
                    // ignores it, which most don't.
                    a.download = "marked-paper.pdf";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                  } catch (err) {
                    alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
                  } finally {
                    setExporting(false);
                  }
                }}
                disabled={exporting}
                title="Download a PDF with red-pen marks for printing"
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-[#c3c6d1]/30 text-sm font-bold text-[#43474f] hover:bg-[#eff4ff] hover:text-[#001e40] transition-all disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-base">file_download</span>
                Export marked paper
              </button>
            ) : null}
          </div>
        )}

        {/* ── Tabs ── */}
        <div className="mb-6">
          <div className="flex items-center gap-1 p-1 bg-white rounded-2xl w-fit shadow-sm">
            <button
              onClick={() => { setShowAll(false); setCurrentIdx(0); setSubmissionPageOverride(null); }}
              className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${!showAll ? "bg-[#001e40] text-white shadow-sm" : "text-[#43474f] hover:bg-[#eff4ff]"}`}
            >
              Incorrect ({incorrectQuestions.length})
            </button>
            <button
              onClick={() => { setShowAll(true); setCurrentIdx(0); setSubmissionPageOverride(null); }}
              className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${showAll ? "bg-[#001e40] text-white shadow-sm" : "text-[#43474f] hover:bg-[#eff4ff]"}`}
            >
              All ({writtenQuestions.length})
            </button>
          </div>
        </div>

        {/* ── Question Review ── */}
        {displayItems.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-3xl shadow-sm">
            {!isMarked ? (
              <>
                <div className="text-5xl mb-4">⏳</div>
                <p className="font-headline text-xl font-extrabold text-[#001e40] mb-1">Not marked yet</p>
                <p className="text-sm text-[#43474f]">This paper hasn&apos;t been AI-marked. Come back once marking is complete.</p>
              </>
            ) : incorrectQuestions.length === 0 ? (
              <>
                <div className="text-5xl mb-4">🎉</div>
                <p className="font-headline text-xl font-extrabold text-[#001e40] mb-1">Perfect score!</p>
                <p className="text-sm text-[#43474f]">You got every question right.</p>
              </>
            ) : (
              <p className="text-sm text-[#43474f]">No questions to show.</p>
            )}
          </div>
        ) : (
          <div>
            {/* Navigation header — desktop */}
            <div className="hidden lg:flex items-center justify-between mb-4">
              <h2 className="font-headline text-2xl font-extrabold text-[#001e40]">Question Review</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { setCurrentIdx((i) => Math.max(0, i - 1)); setSubmissionPageOverride(null); }}
                  disabled={currentIdx === 0}
                  className="w-10 h-10 rounded-full border border-[#c3c6d1]/40 flex items-center justify-center text-[#001e40] hover:bg-[#eff4ff] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <span className="material-symbols-outlined">chevron_left</span>
                </button>
                <span className="text-sm font-bold text-[#001e40] tabular-nums">
                  {currentItem?.type === "section"
                    ? `Q${currentItem.questions[0]?.questionNum}–${currentItem.questions[currentItem.questions.length - 1]?.questionNum}`
                    : String(currentIdx + 1).padStart(2, "0")
                  } of {String(displayItems.length).padStart(2, "0")}
                </span>
                <button
                  onClick={() => { setCurrentIdx((i) => Math.min(displayItems.length - 1, i + 1)); setSubmissionPageOverride(null); }}
                  disabled={currentIdx === displayItems.length - 1}
                  className="w-10 h-10 rounded-full border border-[#c3c6d1]/40 flex items-center justify-center text-[#001e40] hover:bg-[#eff4ff] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <span className="material-symbols-outlined">chevron_right</span>
                </button>
              </div>
            </div>

            {/* Navigation — mobile: prominent centered style */}
            <nav className="lg:hidden flex items-center justify-between px-2 mb-4">
              <button
                onClick={() => { setCurrentIdx((i) => Math.max(0, i - 1)); setSubmissionPageOverride(null); }}
                disabled={currentIdx === 0}
                className="w-12 h-12 flex items-center justify-center rounded-xl bg-[#eff4ff] text-[#001e40] hover:scale-105 transition-transform disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <div className="flex flex-col items-center">
                <span className="text-[10px] font-bold text-[#43474f] tracking-[0.2em] uppercase mb-1">Question</span>
                <span className="font-headline font-extrabold text-2xl text-[#001e40]">
                  {currentItem?.type === "section"
                    ? <>{currentItem.questions[0]?.questionNum}–{currentItem.questions[currentItem.questions.length - 1]?.questionNum}</>
                    : currentIdx + 1
                  } <span className="text-[#43474f] font-medium text-lg">of {displayItems.length}</span>
                </span>
              </div>
              <button
                onClick={() => { setCurrentIdx((i) => Math.min(displayItems.length - 1, i + 1)); setSubmissionPageOverride(null); }}
                disabled={currentIdx === displayItems.length - 1}
                className="w-12 h-12 flex items-center justify-center rounded-xl bg-[#eff4ff] text-[#001e40] hover:scale-105 transition-transform disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </nav>

            {/* Typed English section review (Grammar Cloze, Editing, etc.) */}
            {currentQ && isTypedSection && (() => {
              // Parse word bank from passage table rows
              const wordBank = new Map<string, string>();
              const passageLines = (currentSection?.passage ?? "").split("\n");
              const tableRows: string[][] = [];
              for (const line of passageLines) {
                if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) continue; // skip separator
                if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
                  tableRows.push(line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim()));
                }
              }
              // Word bank: row 0 = letters (A, B, C...), row 1 = words
              if (tableRows.length >= 2) {
                for (let c = 0; c < tableRows[0].length; c++) {
                  const letter = tableRows[0][c].toUpperCase();
                  const word = tableRows[1]?.[c] ?? "";
                  if (letter && word) wordBank.set(letter, word);
                }
                // Handle additional rows (letters continue): row 2 = more letters, row 3 = more words
                for (let r = 2; r + 1 < tableRows.length; r += 2) {
                  for (let c = 0; c < tableRows[r].length; c++) {
                    const letter = tableRows[r][c].toUpperCase();
                    const word = tableRows[r + 1]?.[c] ?? "";
                    if (letter && word) wordBank.set(letter, word);
                  }
                }
              }

              const rawLabel = currentSection?.label ?? "";
              const isGrammarCloze = currentSectionLabel.includes("grammar cloze") || rawLabel.includes("完成对话") || rawLabel.includes("对话填空");
              const isEditing = currentSectionLabel.includes("editing");
              const isSynthesis = currentSectionLabel.includes("synthesis");
              // Chinese 阅读理解 sections (including the merged
              // 阅读理解A / 阅读理解B from 五-A/B) reuse the comp-OEQ
              // split layout: passage on the left, questions on the
              // right. Detection is on the original (non-lowercased)
              // label so the Chinese characters match.
              const isChineseComp = rawLabel.includes("阅读理解") && !rawLabel.includes("短文填空");
              const isCompOeq = currentSectionLabel.includes("comprehension oeq") || currentSectionLabel.includes("comprehension open") || isChineseComp;
              const isCompCloze = currentSectionLabel.includes("comprehension") && currentSectionLabel.includes("cloze") && !isCompOeq;
              const isVocabCloze = (currentSectionLabel.includes("vocab") && currentSectionLabel.includes("cloze")) || rawLabel.includes("短文填空");
              const isVisualText = currentSectionLabel.includes("visual") && currentSectionLabel.includes("text");
              const totalMarks = sectionQuestions.reduce((s, q) => s + (q.marksAvailable ?? 1), 0);
              const earnedMarks = sectionQuestions.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
              // Split-screen layout for passage-bound comp sections on
              // lg+ — passage on the left, questions/answers on the
              // right, each pane scrolls independently. Below lg the
              // existing single-column stacked layout is preserved.
              // Visual Text used to be split-screen too, but the
              // questions column got squeezed on tablets (~410 px
              // wide) and the MCQ options ran into each other.
              // Reverted to grammar-cloze-style single-column so the
              // visual passes use the full content width.
              const useSplitScreen = isCompOeq;
              // Position-based mapping for cloze / editing markers in
              // the passage. Each `**(N)**` token in the passage
              // corresponds to the i-th question in the section
              // (sorted by question number). When a paper has TWO
              // grammar-cloze passages and the AI re-numbered the
              // markers (e.g. passage-2 starts at (1) again instead
              // of continuing from (16)), looking up by raw marker
              // number would either miss the question entirely or
              // match the wrong section's question. Mirror the
              // quiz-player's PassageWithInputs logic here.
              const markerToQuestion = new Map<number, ReviewQuestion>();
              const markerToDisplayNum = new Map<number, string>();
              if (currentSection?.passage && (isGrammarCloze || isEditing || isCompCloze)) {
                const passageQNumsInOrder: number[] = [];
                const seen = new Set<number>();
                const passageRegex = /\*\*\((\d+)\)/g;
                let pm: RegExpExecArray | null;
                while ((pm = passageRegex.exec(currentSection.passage)) !== null) {
                  const n = parseInt(pm[1]);
                  if (!seen.has(n)) { passageQNumsInOrder.push(n); seen.add(n); }
                }
                const sortedSecQs = [...sectionQuestions].sort((a, b) =>
                  a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true })
                );
                passageQNumsInOrder.forEach((pn, i) => {
                  if (i < sortedSecQs.length) {
                    markerToQuestion.set(pn, sortedSecQs[i]);
                    markerToDisplayNum.set(pn, sortedSecQs[i].questionNum);
                  }
                });
              }
              // Chinese 阅读理解 sections use a 50/50 split (matches
              // the quiz player) and DROP the lg:my-[-32px] viewport-
              // stretch — without that the "Question Review" header
              // overlaps the top of the section card. English Comp
              // OEQ keeps its 3:2 split + negative margin unchanged.
              const cardCls = useSplitScreen
                ? (isChineseComp
                  ? "bg-white rounded-3xl p-5 lg:p-6 shadow-sm border border-[#e5eeff] lg:grid lg:grid-cols-2 lg:gap-6 lg:grid-rows-[auto_1fr] lg:min-h-[calc(100vh-160px)] lg:w-screen lg:max-w-none lg:mx-[calc(-50vw+50%)]"
                  : "bg-white rounded-3xl p-5 lg:p-6 shadow-sm border border-[#e5eeff] lg:grid lg:grid-cols-[3fr_2fr] lg:gap-6 lg:grid-rows-[auto_1fr_auto] lg:min-h-[calc(100vh-96px)] lg:my-[-32px] lg:w-screen lg:max-w-none lg:mx-[calc(-50vw+50%)]")
                : "bg-white rounded-3xl p-5 lg:p-8 shadow-sm border border-[#e5eeff]";
              const headerInCardCls = useSplitScreen ? "lg:col-span-2" : "";
              const passageColCls = useSplitScreen ? "lg:row-start-2 lg:col-start-1 lg:overflow-y-auto lg:pr-2 lg:min-h-0" : "";
              const questionsColCls = useSplitScreen ? "lg:row-start-2 lg:col-start-2 lg:overflow-y-auto lg:pl-2 lg:min-h-0" : "";

              return (
                <div className={cardCls}>
                  <div className={headerInCardCls}>
                  {/* Section header — also hosts the passage pen toolbar
                      (parents only) so Pen / Clear stay docked here
                      regardless of how the parent scrolls the passage. */}
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <h3 className="font-headline text-lg font-extrabold text-[#001e40]">{currentSection?.label}</h3>
                    <div className="flex items-center gap-2">
                      {!isStudent && currentSection?.passage && !currentSection.passage.startsWith("[") && (
                        <>
                          <button
                            type="button"
                            onClick={() => setPassagePenActive(v => !v)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-bold shadow-sm border ${
                              passagePenActive
                                ? "bg-rose-600 text-white border-rose-700 hover:bg-rose-700"
                                : "bg-white text-rose-600 border-rose-300 hover:bg-rose-50"
                            }`}
                            title={passagePenActive ? "Pen on — tap to disable" : "Tap to draw on the passage"}
                          >
                            {passagePenActive ? "Pen on" : "Pen"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPassagePenClearSignal(s => s + 1)}
                            className="px-2.5 py-1 rounded-lg text-xs font-bold bg-white text-slate-600 border border-slate-300 hover:bg-slate-50 shadow-sm"
                            title="Clear all passage ink"
                          >
                            Clear
                          </button>
                        </>
                      )}
                      <span className={`text-sm font-bold px-3 py-1 rounded-full ${
                        earnedMarks === totalMarks ? "bg-[#d1fae5] text-[#006c49]" : earnedMarks > 0 ? "bg-[#fef3c7] text-[#633f00]" : "bg-[#ffdad6] text-[#ba1a1a]"
                      }`}>{earnedMarks} / {totalMarks}</span>
                    </div>
                  </div>
                  {isSynthesis && (
                    <p className="text-xs text-[#43474f] mb-6 italic">
                      Strict marking follows MOE guideline. No partial marks given.
                    </p>
                  )}
                  </div>

                  <div className={passageColCls}>
                  {/* Visual Text passage images — passage is stored as a sentinel
                      like "[VISUAL_PAGES:paperId:0,1]" and resolved to scanned pages. */}
                  {currentSection?.passage && currentSection.passage.startsWith("[VISUAL_") && (
                    <VisualTextImages passage={currentSection.passage} fallbackImage={sectionQuestions[0]?.imageData ?? undefined} />
                  )}
                  {/* Passage text. Skipped for Synthesis sections —
                      the "passage" there is just the raw OCR extract
                      of the section text, which duplicates content
                      that's already shown per-question below. Go
                      straight into the questions/answers. */}
                  {currentSection?.passage && !currentSection.passage.startsWith("[") && !isSynthesis && (
                    <div className={`mb-6 bg-[#f8f9ff] rounded-2xl p-5 lg:p-8 border border-slate-100 max-h-[32rem] overflow-y-auto w-full relative ${useSplitScreen ? "lg:max-h-none lg:overflow-visible" : ""}`}>
                      <ReviewPenOverlay
                        key={`passage:${currentSection?.label ?? "unnamed"}`}
                        paperId={id}
                        storageKey={`passage:${currentSection?.label ?? "unnamed"}`}
                        initialDataUrl={data.reviewAnnotations?.[`passage:${currentSection?.label ?? "unnamed"}`] ?? null}
                        readOnly={isStudent}
                        onSaved={handlePenSaved}
                        controlledActive={passagePenActive}
                        clearSignal={passagePenClearSignal}
                        scaleToFit
                      />
                      {(() => {
                        const pLines = currentSection.passage!.split("\n");
                        // Detect line-numbered table (Comp OEQ reading passage)
                        const isLineTable = pLines.some((l: string) => l.trim().startsWith("|") && l.includes("Text"));
                        // Chinese 阅读理解 passages come in the same
                        // line-numbered table shape, but the printed
                        // 华文 paper has no line-number margin and the
                        // student doesn't need to look anything up by
                        // line. Render as plain paragraphs with full
                        // body font, matching the quiz player's
                        // toParagraphs layout. English compre OEQ keeps
                        // the small-font + margin-number layout below.
                        // Chinese 阅读理解 passage stored as PLAIN
                        // paragraphs (post-OCR-prompt-rework — the
                        // 华文 OCR step now emits plain text instead
                        // of a line-numbered table). Split on blank
                        // lines, render each as a textIndent paragraph
                        // through ReviewRichText so **bold** / __underline__
                        // markers render.
                        if (!isLineTable && isChineseComp) {
                          const paras = currentSection.passage!
                            .split(/\n\s*\n+/)
                            .map(p => p.replace(/^[\s\t　]+|\s+$/g, ""))
                            .filter(Boolean);
                          if (paras.length > 0) {
                            return paras.map((para, pi) => (
                              <p key={pi} className="text-base text-[#0b1c30] leading-loose mb-3 last:mb-0" style={{ textIndent: "2em", whiteSpace: "pre-wrap" }}>
                                <ReviewRichText text={para} />
                              </p>
                            ));
                          }
                        }
                        if (isLineTable && isChineseComp) {
                          const rows: string[][] = [];
                          for (const line of pLines) {
                            if ((line as string).match(/^\s*\|[\s-:|]+\|\s*$/)) continue;
                            if ((line as string).trim().startsWith("|") && (line as string).trim().endsWith("|")) {
                              rows.push((line as string).trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map((c: string) => c));
                            }
                          }
                          // Drop the header row ("| Line | Text | No. |").
                          const dataRows = rows.length > 1 ? rows.slice(1) : rows;
                          // Group rows into paragraphs: an indented
                          // (tab / 4-space) row opens a new paragraph;
                          // an empty row closes the current one; every
                          // other non-blank row continues the current.
                          const paras: string[] = [];
                          let cur = "";
                          const pushCur = () => { if (cur.trim()) paras.push(cur.replace(/^[\s\t　]+/, "").trim()); cur = ""; };
                          for (const cells of dataRows) {
                            const rawCell = cells[1] ?? "";
                            // Strip ONE leading pipe-padding space (markdown
                            // pads each cell as ` text `). What remains is
                            // the OCR's own indent, if any.
                            const cell = rawCell.startsWith(" ") ? rawCell.slice(1) : rawCell;
                            const text = cell.replace(/^[\s\t　]+|\s+$/g, "");
                            // Accept tab, 2+ ASCII spaces, OR a leading
                            // full-width space (U+3000). The Chinese OCR
                            // occasionally returns 　 (full-width) for the
                            // paragraph indent instead of 4 ASCII spaces.
                            const isIndentedRow = /^[\t　]|^ {2,}/.test(cell);
                            if (!text) { pushCur(); continue; }
                            if (isIndentedRow && cur) { pushCur(); }
                            cur += text;
                          }
                          pushCur();
                          // Defensive fallback: if NO indent was found and
                          // we ended up with one giant paragraph, try
                          // splitting on Chinese sentence terminators so
                          // the student isn't stuck reading a wall of
                          // text. Better wrong-than-none.
                          if (paras.length <= 1 && paras[0] && paras[0].length > 200) {
                            const joined = paras[0];
                            const sentences = joined.split(/(?<=[。!?！？])\s*/).filter(s => s.trim().length > 0);
                            if (sentences.length > 3) {
                              // Re-group every 3-4 sentences into a paragraph.
                              const regrouped: string[] = [];
                              for (let i = 0; i < sentences.length; i += 3) {
                                regrouped.push(sentences.slice(i, i + 3).join(""));
                              }
                              return regrouped.map((para, pi) => (
                                <p key={pi} className="text-base text-[#0b1c30] leading-loose mb-3 last:mb-0" style={{ textIndent: "2em", whiteSpace: "pre-wrap" }}>
                                  <ReviewRichText text={para} />
                                </p>
                              ));
                            }
                          }
                          return paras.map((para, pi) => (
                            <p key={pi} className="text-base text-[#0b1c30] leading-loose mb-3 last:mb-0" style={{ textIndent: "2em", whiteSpace: "pre-wrap" }}>
                              <ReviewRichText text={para} />
                            </p>
                          ));
                        }
                        if (isLineTable && isCompOeq) {
                          const rows: string[][] = [];
                          for (const line of pLines) {
                            if ((line as string).match(/^\s*\|[\s-:|]+\|\s*$/)) continue;
                            if ((line as string).trim().startsWith("|") && (line as string).trim().endsWith("|")) {
                              rows.push((line as string).trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map((c: string) => c.trim()));
                            }
                          }
                          const dataRows = rows.length > 1 ? rows.slice(1) : rows;
                          let oeqLineCount = 0;
                          const oeqMargins = dataRows.map((cells: string[]) => {
                            const t = cells[1]?.trim() ?? "";
                            const ln = cells[0]?.trim() ?? "";
                            if (t && ln) { oeqLineCount++; return oeqLineCount % 5 === 0 ? String(oeqLineCount) : ""; }
                            return "";
                          });
                          return dataRows.map((cells: string[], ri: number) => {
                            const textContent = cells[1]?.trim() ?? "";
                            const marginNum = oeqMargins[ri];
                            const isEmpty = !textContent && !cells[0]?.trim();
                            return (
                              <div key={ri} className={`flex gap-3 ${isEmpty ? "h-4" : "min-h-[1.6rem]"}`}>
                                <p className={`flex-1 text-[11px] text-[#0b1c30] leading-relaxed text-justify ${textContent.startsWith("    ") || textContent.startsWith("\t") ? "pl-8" : ""}`} style={{ overflowWrap: "break-word", wordBreak: "break-word", hyphens: "auto", fontSize: "clamp(11px, 0.95vw, 13.5px)" }}>{textContent.replace(/^\s+/, "")}</p>
                                {marginNum && <span className="w-5 text-right text-[#003366] font-bold font-mono shrink-0" style={{ fontSize: "clamp(10px, 0.78vw, 12px)" }}>{marginNum}</span>}
                              </div>
                            );
                          });
                        }
                        // Chinese 短文填空 review — render the passage with
                        // each **________** blank replaced by the student's
                        // pick (green if correct, red if wrong) and a
                        // tick / cross indicator. Mirrors the inline-picker
                        // layout the quiz player uses, but read-only and
                        // marked-up. Stop at the "---OPTIONS---" divider
                        // so the options block (already shown per-question
                        // below) doesn't render twice.
                        if (isVocabCloze && rawLabel.includes("短文填空")) {
                          const sortedSecQs = [...sectionQuestions].sort((a, b) =>
                            a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true })
                          );
                          let blankIdx = 0;
                          const divIdx = (currentSection?.passage ?? "").indexOf("---OPTIONS---");
                          const passageOnly = divIdx >= 0 ? (currentSection?.passage ?? "").slice(0, divIdx) : (currentSection?.passage ?? "");
                          return passageOnly.split("\n").map((line: string, li: number) => {
                            if (!line.trim()) return <br key={li} />;
                            const parts: React.ReactNode[] = [];
                            const re = /\*\*[^*]+\*\*/g;
                            let lastEnd = 0;
                            let m: RegExpExecArray | null;
                            while ((m = re.exec(line)) !== null) {
                              if (m.index > lastEnd) parts.push(<span key={`t${lastEnd}`}>{line.slice(lastEnd, m.index)}</span>);
                              const q = sortedSecQs[blankIdx++];
                              if (!q) {
                                parts.push(<span key={`miss${m.index}`} className="text-slate-400 mx-1">______</span>);
                                lastEnd = m.index + m[0].length;
                                continue;
                              }
                              const opts = (q.transcribedOptions as string[] | null) ?? [];
                              const studentRaw = (q.studentAnswer ?? "").trim();
                              const correctRaw = mcqAnswerHead(q.answer);
                              const studentNum = parseInt(studentRaw, 10);
                              const correctNum = parseInt(correctRaw, 10);
                              const isBlank = !studentRaw || studentRaw === "__SKIPPED__" || isNaN(studentNum);
                              const earned = q.marksAwarded ?? 0;
                              const available = q.marksAvailable ?? 1;
                              const isCorrect = !isBlank && (earned >= available || studentNum === correctNum);
                              const studentText = !isNaN(studentNum) && studentNum >= 1 ? (opts[studentNum - 1] ?? "") : "";
                              const correctText = !isNaN(correctNum) && correctNum >= 1 ? (opts[correctNum - 1] ?? "") : "";
                              parts.push(
                                <span key={`q${q.questionNum}`} className="inline-flex items-baseline gap-1 align-middle mx-1 my-1 px-2 py-0.5 rounded-md border bg-white">
                                  <span className="text-[8px] font-bold text-blue-600 bg-blue-50 px-1 rounded leading-none relative -top-px">Q{parseInt(q.questionNum)}</span>
                                  {isBlank ? (
                                    <>
                                      <span className="font-bold text-[#ba1a1a] text-sm">[Blank]</span>
                                      <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                      <span className="font-bold text-[#006c49] text-sm">({correctNum}) {correctText}</span>
                                    </>
                                  ) : isCorrect ? (
                                    <span className="font-bold text-[#006c49] text-sm">({correctNum}) {correctText}</span>
                                  ) : (
                                    <>
                                      <span className="font-bold text-[#ba1a1a] text-sm">({studentNum}) {studentText}</span>
                                      <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                      <span className="font-bold text-[#006c49] text-sm">({correctNum}) {correctText}</span>
                                    </>
                                  )}
                                </span>
                              );
                              lastEnd = m.index + m[0].length;
                            }
                            if (lastEnd < line.length) parts.push(<span key="end">{line.slice(lastEnd)}</span>);
                            const indent = line.match(/^(\s{2,}|\t)/);
                            return <p key={li} className="text-sm text-[#0b1c30] leading-loose my-1" style={indent ? { textIndent: "2em" } : { textIndent: "2em" }}>{parts.length > 0 ? parts : line}</p>;
                          });
                        }
                        // English Vocab Cloze passage — same shape the
                        // quiz player renders: every **bold** chunk is
                        // either an underlined keyword (bold + underline)
                        // or a blank (bold underscores). Strip an
                        // optional leading "(N) " prefix and surrounding
                        // __ markers so the eye lands on the word, not
                        // the markdown.
                        if (isVocabCloze) {
                          return pLines.map((line: string, li: number) => {
                            if (!line.trim()) return <br key={li} />;
                            const parts: React.ReactNode[] = [];
                            const re = /\*\*([^*]+)\*\*/g;
                            let lastEnd = 0;
                            let m: RegExpExecArray | null;
                            while ((m = re.exec(line)) !== null) {
                              if (m.index > lastEnd) parts.push(<span key={`t${lastEnd}`}>{line.slice(lastEnd, m.index)}</span>);
                              const raw = m[1] ?? "";
                              const numMatch = raw.match(/^\s*\((\d+)\)\s*/);
                              const trimmed = (numMatch ? raw.slice(numMatch[0].length) : raw).trim();
                              const inner = trimmed.replace(/^__|__$/g, "");
                              const isUnderscoreBlank = /^_{2,}$/.test(inner);
                              if (inner) {
                                parts.push(
                                  isUnderscoreBlank ? (
                                    <span key={`b${m.index}`} className="font-bold underline decoration-2 decoration-[#001e40] underline-offset-2 text-[#001e40] tracking-widest">________</span>
                                  ) : (
                                    <span key={`w${m.index}`} className="font-bold underline decoration-2 decoration-[#001e40] underline-offset-2 text-[#001e40]">{inner}</span>
                                  )
                                );
                              }
                              lastEnd = m.index + m[0].length;
                            }
                            if (lastEnd < line.length) parts.push(<span key="end">{line.slice(lastEnd)}</span>);
                            const indent = line.match(/^(\s{2,}|\t)/);
                            return (
                              <p key={li} className="leading-relaxed text-base text-[#001e40] my-1" style={indent ? { textIndent: "2em" } : undefined}>
                                {parts.length > 0 ? parts : line}
                              </p>
                            );
                          });
                        }
                        // Standard passage (grammar cloze, editing, comp cloze)
                        return pLines.map((line: string, li: number) => {
                          if (!line.trim()) return <br key={li} />;
                          if ((line as string).match(/^\s*\|[\s-:|]+\|\s*$/)) return null;
                          if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
                            const cells = line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map((c: string) => c.trim());
                            return (
                              <div key={li} className="flex gap-1 my-1">
                                {cells.map((cell: string, ci: number) => (
                                  <span key={ci} className="flex-1 text-center text-xs font-medium text-[#001e40] bg-white rounded px-2 py-1">{cell}</span>
                                ))}
                              </div>
                            );
                          }
                          // Render inline: editing shows error words, cloze shows blanks
                          const parts: React.ReactNode[] = [];
                          const mkRegex = /\*\*\((\d+)\)([^*]*)\*\*/g;
                          let lastEnd = 0;
                          let mk;
                          while ((mk = mkRegex.exec(line)) !== null) {
                            if (mk.index > lastEnd) parts.push(<span key={`t${lastEnd}`}>{line.slice(lastEnd, mk.index)}</span>);
                            const markerNum = parseInt(mk[1]);
                            // Use position-based map first; fall back to raw
                            // number lookup for sections that don't have a
                            // pre-built map (e.g. a future section type).
                            const mappedQ = markerToQuestion.get(markerNum);
                            const num = mappedQ ? mappedQ.questionNum : mk[1];
                            const word = mk[2].trim();
                            if (isEditing && word) {
                              // Editing: show misspelled word + student's correction
                              // in brackets. Green if matches answer key, red if
                              // wrong (with the correct answer also shown in
                              // green so reader sees the right word). Same
                              // rendering for parent and student.
                              const q = mappedQ ?? sectionQuestions.find(sq => sq.questionNum === num);
                              // English Test Quiz marks written before the
                              // markExamPaper persist-studentAnswer fix only
                              // recorded the detected text in markingNotes
                              // ("Detected: X | ..."). Pull it back out as
                              // a fallback so the inline editing view shows
                              // the wrong word instead of "No answer".
                              const detectedFromNotes = !q?.studentAnswer
                                ? (q?.markingNotes?.match(/^Detected:\s*([\s\S]+?)(?:\s*\||$)/)?.[1]?.trim() ?? "")
                                : "";
                              const studentAns = (q?.studentAnswer ?? detectedFromNotes).trim();
                              const correctAns = cleanOneWordAnswer(q?.answer ?? "");
                              const isBlank = !studentAns || studentAns === "__SKIPPED__";
                              const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
                              // Trust the AI marker: full marks earned means
                              // green even if the student's spelling differs
                              // slightly from the answer key (an accepted
                              // variant). Otherwise fall back to a string
                              // comparison so legacy / unmarked rows still
                              // pick up obvious matches.
                              const earned = q?.marksAwarded ?? 0;
                              const available = q?.marksAvailable ?? 1;
                              // Marker is authoritative: full marks → green even
                              // if studentAns is empty (scan-back English may
                              // not have populated the typed text).
                              const fullMarks = earned >= available && available > 0;
                              const isMatch = fullMarks || (!isBlank && norm(studentAns) === norm(correctAns));
                              parts.push(
                                <span key={`q${num}`} className="inline-flex items-baseline gap-0.5 mx-0.5">
                                  <span className="text-[8px] font-bold text-blue-600 bg-blue-50 px-0.5 rounded leading-none relative -top-px">{num}</span>
                                  <span className="underline decoration-red-400 decoration-2 font-bold text-red-700 text-sm">{word}</span>
                                  {isMatch ? (
                                    <>
                                      <span className="font-bold text-[#006c49] text-sm">[{studentAns || correctAns}]</span>
                                      <span className="material-symbols-outlined text-[#006c49]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>check</span>
                                    </>
                                  ) : isBlank ? (
                                    // Blank AND not awarded — show correct in red
                                    <>
                                      <span className="font-bold text-[#ba1a1a] text-sm">[{correctAns}]</span>
                                      <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="font-bold text-[#ba1a1a] text-sm">[{studentAns}]</span>
                                      <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                      <span className="font-bold text-[#ba1a1a] text-sm">[{correctAns}]</span>
                                    </>
                                  )}
                                </span>
                              );
                            } else if (isVocabCloze && word) {
                              // Vocab cloze: show the underlined word the student must replace
                              parts.push(
                                <span key={`q${num}`} className="inline-flex items-center gap-0.5 mx-0.5">
                                  <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({num})</span>
                                  <span className="underline decoration-2 font-semibold text-[#001e40] px-1 text-sm">{word}</span>
                                </span>
                              );
                            } else if (isCompCloze) {
                              // Comprehension Cloze: student types the missing
                              // word directly (no word bank). Trust the AI
                              // marker — if full marks earned, render green
                              // even if studentAns is empty (scan-back may
                              // have detected from the bounded crop without
                              // populating the typed-text field).
                              const q = mappedQ ?? sectionQuestions.find(sq => sq.questionNum === num);
                              // Detected-from-notes fallback (see editing
                              // branch above for the why).
                              const detectedFromNotes = !q?.studentAnswer
                                ? (q?.markingNotes?.match(/^Detected:\s*([\s\S]+?)(?:\s*\||$)/)?.[1]?.trim() ?? "")
                                : "";
                              const studentAns = (q?.studentAnswer ?? detectedFromNotes).trim();
                              const correctAns = cleanOneWordAnswer(q?.answer ?? "");
                              const isBlank = !studentAns || studentAns === "__SKIPPED__";
                              const earned = q?.marksAwarded ?? 0;
                              const available = q?.marksAvailable ?? 1;
                              const fullMarks = earned >= available && available > 0;
                              const isMatch = fullMarks || (!isBlank && studentAns.toLowerCase() === correctAns.toLowerCase());
                              parts.push(
                                <span key={`q${num}`} className="inline-flex items-baseline gap-0.5 mx-0.5">
                                  <span className="text-[8px] font-bold text-blue-600 bg-blue-50 px-0.5 rounded leading-none relative -top-px">{num}</span>
                                  {isMatch ? (
                                    <>
                                      <span className="font-bold text-[#006c49] underline decoration-2 decoration-[#006c49]/40 underline-offset-2 px-1 text-sm">{studentAns || correctAns}</span>
                                      <span className="material-symbols-outlined text-[#006c49]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>check</span>
                                    </>
                                  ) : isBlank ? (
                                    <>
                                      <span className="font-bold text-[#ba1a1a] underline decoration-2 decoration-[#ba1a1a]/40 underline-offset-2 px-1 text-sm">{correctAns}</span>
                                      <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="font-bold text-[#ba1a1a] px-1 text-sm">{studentAns}</span>
                                      <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                      <span className="font-bold text-[#ba1a1a] px-1 text-sm">{correctAns}</span>
                                    </>
                                  )}
                                </span>
                              );
                            } else if (isGrammarCloze) {
                              // Grammar cloze: fill the blank with the actual word the
                              // student chose (looked up from the word bank by letter).
                              // Green = correct, red = wrong (with the correct word
                              // shown next to it). No answer = empty underline.
                              //
                              // The answer key may be stored as "C", "(C)", "C: HIS",
                              // "(C) HIS" etc. — extract the leading letter so the
                              // comparison and word-bank lookup don't fail when the
                              // key carries the word too.
                              // Accept letters (English A-Q) or digits (Chinese
                              // 完成对话 uses 1-8 as word-bank keys).
                              const extractLetter = (raw: string) => {
                                const m = raw.trim().toUpperCase().match(/^[(\s]*([A-Z]|\d+)\b/);
                                return m ? m[1] : raw.trim().toUpperCase();
                              };
                              const q = mappedQ ?? sectionQuestions.find(sq => sq.questionNum === num);
                              // Detected-from-notes fallback (see editing
                              // branch above for the why).
                              const detectedFromNotes = !q?.studentAnswer
                                ? (q?.markingNotes?.match(/^Detected:\s*([\s\S]+?)(?:\s*\||$)/)?.[1]?.trim() ?? "")
                                : "";
                              const studentLetter = extractLetter(q?.studentAnswer ?? detectedFromNotes);
                              const correctLetter = extractLetter(q?.answer ?? "");
                              const studentWord = wordBank.get(studentLetter) ?? "";
                              const correctWord = wordBank.get(correctLetter) ?? correctLetter;
                              const isBlank = !studentLetter || studentLetter === "__SKIPPED__";
                              // Trust the marker first (full marks ⇒ green),
                              // fall back to letter comparison.
                              const earned = q?.marksAwarded ?? 0;
                              const available = q?.marksAvailable ?? 1;
                              // The marker is authoritative. If it awarded full
                              // marks, render green even if studentLetter is
                              // empty (scan-back may have detected the answer
                              // from the bounded crop without populating the
                              // typed-text studentAnswer field).
                              const fullMarks = earned >= available && available > 0;
                              const isCorrect = fullMarks || (!isBlank && studentLetter === correctLetter);
                              // Chinese 完成对话 uses a stricter user-spec
                              // review treatment: blank → red [Blank] + ✗,
                              // correct → green answer only, wrong → red
                              // student + ✗ + GREEN correct. English keeps
                              // the original colour scheme below.
                              const isChineseDialogueCloze = rawLabel.includes("完成对话") || rawLabel.includes("对话填空");
                              parts.push(
                                <span key={`q${num}`} className="inline-flex items-baseline gap-0.5 mx-0.5">
                                  <span className="text-[8px] font-bold text-blue-600 bg-blue-50 px-0.5 rounded leading-none relative -top-px">{num}</span>
                                  {isChineseDialogueCloze ? (
                                    isBlank ? (
                                      <>
                                        <span className="font-bold text-[#ba1a1a] px-1 text-sm">[Blank]</span>
                                        <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                        <span className="font-bold text-[#006c49] px-1 text-sm">{correctWord}</span>
                                      </>
                                    ) : isCorrect ? (
                                      <span className="font-bold text-[#006c49] px-1 text-sm">{correctWord}</span>
                                    ) : (
                                      <>
                                        <span className="font-bold text-[#ba1a1a] px-1 text-sm">{studentWord || studentLetter}</span>
                                        <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                        <span className="font-bold text-[#006c49] px-1 text-sm">{correctWord}</span>
                                      </>
                                    )
                                  ) : isCorrect ? (
                                    // English grammar cloze — marker says correct.
                                    // Tick green even if studentWord is empty (scan
                                    // path may have skipped populating the typed
                                    // text). Display the correct word in green
                                    // so the parent still sees what the answer is.
                                    <>
                                      <span className="font-bold text-[#006c49] underline decoration-2 decoration-[#006c49]/40 underline-offset-2 px-1 text-sm">{studentWord || correctWord}</span>
                                      <span className="material-symbols-outlined text-[#006c49]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>check</span>
                                    </>
                                  ) : isBlank ? (
                                    // Student left blank AND marker didn't award
                                    // full marks — red cross + correct in red.
                                    <>
                                      <span className="font-bold text-[#ba1a1a] underline decoration-2 decoration-[#ba1a1a]/40 underline-offset-2 px-1 text-sm">{correctWord}</span>
                                      <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="font-bold text-[#ba1a1a] px-1 text-sm">{studentWord}</span>
                                      <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>close</span>
                                      <span className="font-bold text-[#ba1a1a] px-1 text-sm">{correctWord}</span>
                                    </>
                                  )}
                                </span>
                              );
                            } else {
                              parts.push(
                                <span key={`q${num}`} className="inline-flex items-center gap-0.5 mx-0.5">
                                  <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({num})</span>
                                  <span className="border-b-2 border-slate-300 px-1 text-sm">____</span>
                                </span>
                              );
                            }
                            lastEnd = mk.index + mk[0].length;
                          }
                          if (lastEnd < line.length) parts.push(<span key="end">{line.slice(lastEnd)}</span>);
                          const indent = line.match(/^(\s{2,}|\t)/);
                          return <p key={li} className="text-sm text-[#0b1c30] leading-relaxed my-0.5 text-justify" style={indent ? { textIndent: "2em" } : undefined}>{parts.length > 0 ? parts : line}</p>;
                        });
                      })()}
                    </div>
                  )}

                  {/* Word bank (Grammar Cloze only) */}
                  {isGrammarCloze && wordBank.size > 0 && (
                    <div className="mb-6 bg-[#eff4ff] rounded-2xl p-4">
                      <p className="text-xs font-bold text-[#43474f] mb-2 uppercase tracking-wider">Word Bank</p>
                      <div className="flex flex-wrap gap-2">
                        {[...wordBank.entries()].map(([letter, word]) => (
                          <span key={letter} className="text-xs bg-white rounded-lg px-2 py-1 border border-[#d3e4fe]">
                            <span className="font-bold text-[#003366]">{letter}</span>: {word}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  </div>

                  <div className={questionsColCls}>
                  {/* Question results */}
                  <div className="space-y-3">
                    {sectionQuestions.map((q, qi) => {
                      // Marker says correct?
                      const markerCorrect = q.marksAwarded !== null && q.marksAwarded >= (q.marksAvailable ?? 1);
                      // For one-word topics (Editing / Comp Cloze) also accept
                      // a string match against the CLEANED answer key. Existing
                      // papers extracted before the explanation-stripper had
                      // dirty keys ("Exhilaration | (spelling)") that caused
                      // the AI marker to score correct answers as wrong; the
                      // inline passage already accepts a string match so the
                      // tick was green there but the per-question card was
                      // red. Keep both in agreement.
                      const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
                      // Detected-from-notes fallback so string match also
                      // works on older marks where studentAnswer was never
                      // persisted (Detected: X was only in notes).
                      const detectedFromNotesEarly = !q.studentAnswer
                        ? (q.markingNotes?.match(/^Detected:\s*([\s\S]+?)(?:\s*\||$)/)?.[1]?.trim() ?? "")
                        : "";
                      const stringMatchOk = (isEditing || isCompCloze) && (() => {
                        const stu = (q.studentAnswer ?? detectedFromNotesEarly).trim();
                        if (!stu || stu === "__SKIPPED__") return false;
                        return norm(stu) === norm(cleanOneWordAnswer(q.answer ?? ""));
                      })();
                      // Grammar Cloze: the answer is a single letter from
                      // the word bank (A–Q). If the student's letter
                      // matches the answer key letter, it is correct —
                      // full stop. The AI marker has historically been
                      // unreliable here (mis-classifying as comp cloze and
                      // rejecting the letter as "not a word"), so trust
                      // the letter match the same way we trust a string
                      // match for editing / comp cloze.
                      const grammarLetterMatchOk = isGrammarCloze && (() => {
                        const extractLetter = (raw: string) => {
                          const m = raw.trim().toUpperCase().match(/^[(\s]*([A-Z]|\d+)\b/);
                          return m ? m[1] : raw.trim().toUpperCase();
                        };
                        const stu = extractLetter(q.studentAnswer ?? detectedFromNotesEarly);
                        const cor = extractLetter(q.answer ?? "");
                        if (!stu || stu === "__SKIPPED__" || !cor) return false;
                        // Accept "K or P" / "L/P" alternates in the key.
                        const acceptable = new Set((q.answer ?? "").toUpperCase().match(/\b[A-Z]\b/g) ?? []);
                        if (acceptable.size > 0) return acceptable.has(stu);
                        return stu === cor;
                      })();
                      const qCorrect = markerCorrect || stringMatchOk || grammarLetterMatchOk;
                      const isPartialQ = !qCorrect && (q.marksAwarded ?? 0) > 0;
                      // For Grammar Cloze the answer key is sometimes stored
                      // as "(C)" or "(C) HIS" instead of the bare letter "C".
                      // Pull out the letter so the word-bank lookup + the
                      // 'Your/Correct answer' display doesn't end up showing
                      // "(C) HIS: —".
                      // Accept letters (English A-Q) or digits (Chinese
                      // 完成对话 uses 1-8 as word-bank keys).
                      const extractClozeLetter = (raw: string) => {
                        const m = raw.trim().toUpperCase().match(/^[(\s]*([A-Z]|\d+)\b/);
                        return m ? m[1] : raw.trim().toUpperCase();
                      };
                      // Fallback to the marker's "Detected: X" prefix in
                      // markingNotes when studentAnswer is empty —
                      // older English Test Quiz marks never wrote the
                      // detected text into studentAnswer, only into
                      // notes. New marks save studentAnswer directly so
                      // this branch goes away as papers re-mark.
                      const detectedFromNotes = !q.studentAnswer
                        ? (q.markingNotes?.match(/^Detected:\s*([\s\S]+?)(?:\s*\||$)/)?.[1]?.trim() ?? "")
                        : "";
                      const rawStudent = q.studentAnswer ?? detectedFromNotes;
                      const rawCorrect = q.answer ?? "";
                      const studentAns = isGrammarCloze ? extractClozeLetter(rawStudent) : rawStudent;
                      // Comp Cloze + Editing answer keys may carry an
                      // inline explanation that we don't want to render
                      // ("Exhilaration | (spelling)", "elated (=happy)").
                      // Strip it here so already-extracted dirty answers
                      // still display the clean one-word answer.
                      const correctAns = isGrammarCloze
                        ? extractClozeLetter(rawCorrect)
                        : (isEditing || isCompCloze)
                          ? cleanOneWordAnswer(rawCorrect)
                          : rawCorrect;
                      const studentWord = wordBank.get(studentAns.toUpperCase()) ?? "";
                      const correctWord = wordBank.get(correctAns.toUpperCase()) ?? "";
                      const displayNum = parseInt(q.questionNum);

                      // For synthesis/comp OEQ: clean the stem for display
                      const stemRaw = q.transcribedStem ?? "";
                      const cleanStemDisplay = stemRaw
                        .replace(/\[(?:Lines?:\s*)?\d+\s*(?:lines?)?\]/gi, "")
                        .replace(/\*\*([^*]+)\*\*/g, "$1")
                        .replace(/_{3,}/g, "")
                        .trim();
                      // Extract keyword from synthesis stem
                      const kwMatch = stemRaw.match(/\*\*([^*]+)\*\*/);
                      const keyword = kwMatch ? kwMatch[1].trim() : "";

                      return (
                        <div key={q.id} className={`p-4 rounded-2xl border-2 ${
                          qCorrect ? "bg-[#d1fae5]/30 border-[#006c49]/20" : isPartialQ ? "bg-[#fef3c7]/30 border-[#633f00]/20" : "bg-[#ffdad6]/30 border-[#ba1a1a]/20"
                        }`}>
                          <div className="flex items-start gap-3">
                            <div className="flex flex-col items-center gap-1 shrink-0">
                              <span className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                qCorrect ? "bg-[#006c49] text-white" : isPartialQ ? "bg-[#633f00] text-white" : "bg-[#ba1a1a] text-white"
                              }`}>{displayNum}</span>
                              <button onClick={() => onFlagClick(q.id)} disabled={flagging === q.id}
                                title={flaggedIds.has(q.id) ? "Flagged — click to unflag" : "Flag this question"}
                                className={`transition-colors disabled:opacity-50 ${flaggedIds.has(q.id) ? "text-[#ba1a1a]" : "text-[#737780] hover:text-[#ba1a1a]"}`}>
                                <span className="material-symbols-outlined text-base" style={flaggedIds.has(q.id) ? { fontVariationSettings: "'FILL' 1" } : {}}>flag</span>
                              </button>
                              {/* Speaker — Chinese MCQ only. Reads the
                                  sentence with the correct option
                                  substituted in place of the blank /
                                  underlined phrase. Browser TTS, no
                                  network round-trip. */}
                              {isChineseComp || rawLabel.includes("语文应用") || rawLabel.includes("短文填空") || rawLabel.includes("完成对话") ? (
                                Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4 ? (
                                  <button
                                    type="button"
                                    onClick={() => speakChineseMcq(q.transcribedStem ?? "", q.transcribedOptions as string[], correctAns)}
                                    title="朗读句子"
                                    className="text-[#737780] hover:text-[#003366] transition-colors"
                                  >
                                    <span className="material-symbols-outlined text-base">volume_up</span>
                                  </button>
                                ) : null
                              ) : null}
                            </div>
                            <div className="flex-1 min-w-0">
                              {/* Synthesis / Comp OEQ: show question + typed answer */}
                              {(isSynthesis || isCompOeq) ? (
                                <div className="space-y-2">
                                  {cleanStemDisplay && (
                                    <ReviewRichText text={(() => {
                                      let t = stemRaw.replace(/\[(?:Lines?:\s*)?\d+\s*(?:lines?)?\]/gi, "").trim();
                                      // Strip table rows from stem if answer is table-based (avoid showing blank table)
                                      if (studentAns.startsWith("{")) {
                                        t = t.split("\n").filter(l => !l.trim().startsWith("|")).join("\n").trim();
                                      }
                                      // Synthesis: trim off the answer template (the
                                      // **keyword** + blank ____ lines) so we only show
                                      // the source sentence(s) the student is rewriting.
                                      // Keeping the scaffolding clutters the review.
                                      if (isSynthesis) {
                                        const lines = t.split("\n");
                                        let endIdx = lines.length;
                                        for (let i = 0; i < lines.length; i++) {
                                          if (/\*\*|_{3,}/.test(lines[i])) { endIdx = i; break; }
                                        }
                                        t = lines.slice(0, endIdx).join("\n").trim();
                                      }
                                      return t;
                                    })()} />
                                  )}
                                  <div className="bg-white rounded-lg p-3 border border-slate-200">
                                    <p className="text-xs font-bold text-[#43474f] mb-1">Your answer:</p>
                                    {Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4 ? (
                                      // Chinese 阅读理解 A is a mixed
                                      // MCQ + OEQ section, but the
                                      // comp-OEQ render path was
                                      // shoving MCQ Q30-32 through the
                                      // typed-text branch — students
                                      // saw "Student: 1, Correct: 2"
                                      // with no option text. Show the
                                      // full option list with green
                                      // for correct + red for picked.
                                      <div className="space-y-1.5">
                                        {q.transcribedOptions.map((opt: string, oi: number) => {
                                          const optNum = String(oi + 1);
                                          const isOptCorrect = mcqAnswerHead(correctAns) === optNum;
                                          const isSelected = studentAns === optNum;
                                          return (
                                            <div key={oi} className={`flex items-start gap-2 p-2 rounded-lg text-sm ${
                                              isOptCorrect ? "bg-[#d1fae5] border border-[#006c49]/20" : isSelected ? "bg-[#ffdad6] border border-[#ba1a1a]/20" : "bg-[#f8f9ff] border border-transparent"
                                            }`}>
                                              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5 ${
                                                isOptCorrect ? "bg-[#006c49] text-white" : isSelected ? "bg-[#ba1a1a] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                                              }`}>{oi + 1}</span>
                                              <span className={`font-medium ${isOptCorrect || isSelected ? "text-[#001e40]" : "text-[#43474f]"}`}>{opt}</span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : studentAns.startsWith("data:image") ? (
                                      // Chinese 阅读理解 OEQ stores the
                                      // student's 田字格 ink as a PNG
                                      // data-URL. Render the image
                                      // directly — the typed-text path
                                      // below would just dump the
                                      // base64 string into the page.
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img src={studentAns} alt={`Question ${q.questionNum} answer`} className="w-full rounded border border-slate-100" />
                                    ) : studentAns.startsWith("{") ? (
                                      // JSON answer — table cells, ticks, and/or text
                                      (() => {
                                        let cells: Record<string, string> = {};
                                        try { cells = JSON.parse(studentAns); } catch { /* ignore */ }
                                        const textVal = cells._text ?? "";
                                        const ticks = Object.entries(cells).filter(([k, v]) => k.startsWith("tick") && v === "true");
                                        const hasTableCells = Object.keys(cells).some(k => k.startsWith("r"));
                                        // Comp-OEQ with [LINES: N] / ___ markers stores
                                        // each subpart's typed answer under line0,
                                        // line1, … RichStemText writes them; the review
                                        // needs to read them back out and render each
                                        // as its own paragraph.
                                        const lineKeys = Object.keys(cells)
                                          .filter(k => /^line\d+$/.test(k))
                                          .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
                                        const lineValues = lineKeys
                                          .map(k => (cells[k] ?? "").trim())
                                          .filter(v => v.length > 0);

                                        // Recover the actual tick-box option text
                                        // from the stem so 'Your answer' shows
                                        // WHAT was ticked instead of just a count.
                                        // Stem lines that match [ ]/[x]/[✓] (start
                                        // OR end of line) become tick0, tick1, …
                                        // in the same order RichStemText assigns
                                        // them during the quiz.
                                        const tickLines: string[] = [];
                                        for (const line of (q.transcribedStem ?? "").split("\n")) {
                                          const trimmed = line.trim();
                                          const startMatch = trimmed.match(/^\[[ x✓✗]\]\s*(.*)/i);
                                          const endMatch = !startMatch ? trimmed.match(/^(.*?)\s*\[[ x✓✗]\]\s*$/i) : null;
                                          if (startMatch) tickLines.push(startMatch[1].trim());
                                          else if (endMatch) tickLines.push(endMatch[1].trim());
                                        }
                                        const tickedTexts = ticks
                                          .map(([k]) => {
                                            const m = k.match(/^tick(\d+)$/);
                                            const idx = m ? parseInt(m[1]) : -1;
                                            return tickLines[idx] ?? `option ${idx + 1}`;
                                          })
                                          .filter(Boolean);

                                        // If only ticks + text + line answers (no
                                        // table), show all of them.
                                        if (!hasTableCells) {
                                          const hasAny = ticks.length > 0 || lineValues.length > 0 || textVal.trim().length > 0;
                                          return (
                                            <div className="space-y-1">
                                              {tickedTexts.length > 0 && (
                                                <div>
                                                  <p className="text-xs text-[#43474f] mb-1">Ticked:</p>
                                                  <ul className="text-sm text-[#001e40] list-disc pl-5 space-y-0.5">
                                                    {tickedTexts.map((t, i) => (
                                                      <li key={i} className="whitespace-pre-wrap">{t}</li>
                                                    ))}
                                                  </ul>
                                                </div>
                                              )}
                                              {lineValues.map((v, i) => (
                                                <p key={i} className="text-sm text-[#001e40] whitespace-pre-wrap">{v}</p>
                                              ))}
                                              {textVal.trim() && (
                                                <p className="text-sm text-[#001e40] whitespace-pre-wrap">{textVal}</p>
                                              )}
                                              {!hasAny && (
                                                <p className="text-sm"><span className="italic text-[#737780]">No text answer</span></p>
                                              )}
                                            </div>
                                          );
                                        }
                                        const stemLines = stemRaw.split("\n");
                                        let rowIdx = 0;
                                        return (
                                          <div className="space-y-0.5 mt-1">
                                            {stemLines.map((sl: string, sli: number) => {
                                              const tr = sl.trim();
                                              if (tr.match(/^\|[\s-:|]+\|$/)) return null;
                                              if (tr.startsWith("|") && tr.endsWith("|")) {
                                                const tableCells = tr.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map((c: string) => c.trim());
                                                const ri = rowIdx++;
                                                return (
                                                  <div key={sli} className="flex gap-1">
                                                    {tableCells.map((tc: string, ci: number) => {
                                                      const isBlank = !tc || tc.match(/^_{2,}$/);
                                                      const cellKey = `r${ri}c${ci}`;
                                                      const val = isBlank ? (cells[cellKey] ?? "") : tc;
                                                      return (
                                                        <span key={ci} className={`flex-1 text-center text-xs px-2 py-1 rounded border ${
                                                          isBlank ? (val ? "bg-blue-50 border-blue-200 font-semibold text-blue-800" : "bg-slate-50 border-slate-200 text-[#737780] italic") : "bg-[#eff4ff] border-[#d3e4fe] text-[#001e40] font-medium"
                                                        }`}>
                                                          {val || "—"}
                                                        </span>
                                                      );
                                                    })}
                                                  </div>
                                                );
                                              }
                                              return null;
                                            })}
                                          </div>
                                        );
                                      })()
                                    ) : (
                                      <p className="text-sm text-[#001e40] whitespace-pre-wrap">{(() => {
                                        // Synthesis answers store "<before>|||<after>" — the two blanks the
                                        // student filled on either side of the keyword. Splice the actual
                                        // keyword in so the reader sees a full transformed sentence, with
                                        // the keyword(s) bolded so they stand out from the student's text.
                                        if (isSynthesis) {
                                          let combined: string;
                                          if (studentAns.includes("|||")) {
                                            // Mid-sentence keyword: '<before>|||<after>'
                                            const [before, after] = studentAns.split("|||");
                                            combined = `${before.trim()} ${keyword || "…"} ${after.trim()}`.replace(/\s+/g, " ").trim();
                                          } else if (keyword) {
                                            // Single-input format. Only prepend the parts
                                            // the student didn't already type — otherwise
                                            // a student who typed the full sentence ends
                                            // up with the prefix duplicated.
                                            const lines = stemRaw.split("\n");
                                            let leadingText = "";
                                            for (let i = lines.length - 1; i >= 0; i--) {
                                              const m = lines[i].match(/^(.*?)\*\*[^*]+\*\*/);
                                              if (m) { leadingText = m[1].trim(); break; }
                                            }
                                            const fullPrefix = [leadingText, keyword].filter(Boolean).join(" ");
                                            const stuRaw = studentAns.trim();
                                            const stuLower = stuRaw.toLowerCase();
                                            let core = stuRaw;
                                            let prependLeading = !!leadingText;
                                            let prependKeyword = true;
                                            if (fullPrefix && stuLower.startsWith(fullPrefix.toLowerCase())) {
                                              core = stuRaw.slice(fullPrefix.length).trim();
                                              prependLeading = false;
                                              prependKeyword = false;
                                            } else if (stuLower.startsWith(keyword.toLowerCase())) {
                                              core = stuRaw.slice(keyword.length).trim();
                                              prependKeyword = false;
                                            }
                                            const segs = [
                                              prependLeading ? leadingText : "",
                                              prependKeyword ? keyword : "",
                                              core,
                                            ].map(s => s.trim()).filter(Boolean);
                                            combined = segs.join(" ").replace(/\s+/g, " ").trim();
                                            if (!combined) combined = keyword;
                                          } else {
                                            combined = studentAns;
                                          }
                                          if (!combined) return <span className="italic text-[#737780]">No answer</span>;
                                          // Bold every keyword occurrence — synthesis stems may have one
                                          // primary keyword but other significant words may be wrapped
                                          // in **bold** in the stem too.
                                          const keywords = Array.from(stemRaw.matchAll(/\*\*([^*]+)\*\*/g)).map(m => m[1].trim()).filter(Boolean);
                                          if (keywords.length === 0) return combined;
                                          const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                                          const re = new RegExp(`\\b(${keywords.map(escape).join("|")})\\b`, "gi");
                                          const parts = combined.split(re);
                                          return parts.map((p, i) =>
                                            keywords.some(k => k.toLowerCase() === p.toLowerCase())
                                              ? <strong key={i} className="font-bold">{p}</strong>
                                              : <span key={i}>{p}</span>
                                          );
                                        }
                                        return studentAns || <span className="italic text-[#737780]">No answer</span>;
                                      })()}</p>
                                    )}
                                  </div>
                                  {correctAns && !(Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) && (
                                    // Hide the textual "Correct answer:" line
                                    // for MCQ — the option list above already
                                    // highlights the correct option in green
                                    // and the student-picked one in red.
                                    <div className="text-sm text-[#006c49]">
                                      <span className="font-semibold">Correct answer:</span>
                                      <ReviewRichText text={correctAns} />
                                    </div>
                                  )}
                                  {q.marksAvailable && (
                                    <div className="flex items-center gap-2">
                                      {editingMarks === q.id && !isStudent ? (
                                        <div className="flex items-center gap-1.5 bg-slate-50 rounded-full px-2 py-1">
                                          <button
                                            onClick={() => { const v = Math.max(0, (q.marksAwarded ?? 0) - 0.5); updateMarks(q.id, v); }}
                                            disabled={savingMarks || (q.marksAwarded ?? 0) <= 0}
                                            className="w-6 h-6 rounded-full bg-[#ffdad6] text-[#ba1a1a] flex items-center justify-center font-bold text-sm disabled:opacity-30"
                                          >−</button>
                                          <span className="text-xs font-bold text-[#001e40] min-w-[3rem] text-center">
                                            {q.marksAwarded ?? 0} / {q.marksAvailable}
                                          </span>
                                          <button
                                            onClick={() => { const v = Math.min(q.marksAvailable!, (q.marksAwarded ?? 0) + 0.5); updateMarks(q.id, v); }}
                                            disabled={savingMarks || (q.marksAwarded ?? 0) >= q.marksAvailable!}
                                            className="w-6 h-6 rounded-full bg-[#d1fae5] text-[#006c49] flex items-center justify-center font-bold text-sm disabled:opacity-30"
                                          >+</button>
                                          <button onClick={() => setEditingMarks(null)} className="ml-1 text-[#43474f] hover:text-[#001e40]">
                                            <span className="material-symbols-outlined text-sm">check</span>
                                          </button>
                                        </div>
                                      ) : (
                                        <span
                                          onClick={() => { if (!isStudent) setEditingMarks(q.id); }}
                                          className={`text-xs font-bold text-[#43474f] ${!isStudent ? "cursor-pointer hover:text-[#003366]" : ""}`}
                                        >
                                          {q.marksAwarded ?? 0} / {q.marksAvailable} marks
                                          {!isStudent && <span className="material-symbols-outlined text-[10px] ml-1 align-middle opacity-40">edit</span>}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                  {/* Marking notes render once at the
                                      bottom of the question card (outside
                                      this branch) — no per-branch copy
                                      here, otherwise synthesis / comp OEQ
                                      showed the feedback twice. */}
                                </div>
                              ) : (isVocabCloze || isVisualText) && q.transcribedOptions && q.transcribedOptions.length > 0 ? (
                                /* Vocab Cloze / Visual Text — MCQ-style with stem + options */
                                <div className="space-y-2">
                                  {q.transcribedStem && (
                                    <p className="text-sm text-[#0b1c30] leading-relaxed whitespace-pre-wrap">{q.transcribedStem.replace(/__([^_]+)__/g, "______")}</p>
                                  )}
                                  <div className="grid grid-cols-2 gap-1.5">
                                    {q.transcribedOptions.map((opt: string, oi: number) => {
                                      const optNum = String(oi + 1);
                                      const isOptCorrect = mcqAnswerHead(correctAns) === optNum;
                                      const isSelected = studentAns === optNum;
                                      return (
                                        <div key={oi} className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
                                          isOptCorrect ? "bg-[#d1fae5] border border-[#006c49]/20" : isSelected ? "bg-[#ffdad6] border border-[#ba1a1a]/20" : "bg-[#f8f9ff] border border-transparent"
                                        }`}>
                                          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                                            isOptCorrect ? "bg-[#006c49] text-white" : isSelected ? "bg-[#ba1a1a] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                                          }`}>{oi + 1}</span>
                                          <span className={`font-medium ${isOptCorrect || isSelected ? "text-[#001e40]" : "text-[#43474f]"}`}>{opt}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : (
                                /* Grammar Cloze / Editing / Comp Cloze */
                                <>
                                  {qCorrect ? (
                                    <p className="text-sm text-[#006c49] font-semibold">
                                      <span className="material-symbols-outlined text-sm align-middle mr-1" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                                      {isGrammarCloze ? `${correctAns.toUpperCase()}: ${correctWord}` : isEditing ? `"${correctAns}"` : correctAns}
                                    </p>
                                  ) : (
                                    <div className="space-y-1">
                                      <p className="text-sm text-[#ba1a1a] font-semibold">
                                        <span className="material-symbols-outlined text-sm align-middle mr-1" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>
                                        Your answer: {studentAns ? (isGrammarCloze ? `${studentAns.toUpperCase()}: ${studentWord || "—"}` : `"${studentAns}"`) : "No answer"}
                                      </p>
                                      <p className="text-sm text-[#006c49] font-semibold">
                                        Correct answer: {isGrammarCloze ? `${correctAns.toUpperCase()}: ${correctWord}` : isEditing ? `"${correctAns}"` : correctAns}
                                      </p>
                                    </div>
                                  )}
                                  {/* Parent score edit */}
                                  {!isStudent && (
                                    <button
                                      onClick={() => {
                                        const newMarks = qCorrect ? 0 : (q.marksAvailable ?? 1);
                                        updateMarks(q.id, newMarks);
                                      }}
                                      disabled={savingMarks}
                                      className="mt-1 text-[10px] font-bold text-[#737780] hover:text-[#003366] transition-colors flex items-center gap-1 disabled:opacity-50"
                                    >
                                      <span className="material-symbols-outlined text-xs">edit</span>
                                      {qCorrect ? "Mark as wrong" : "Mark as correct"}
                                    </button>
                                  )}
                                </>
                              )}
                              {/* Marking notes/reason for wrong/partial */}
                              {q.markingNotes && !q.markingNotes.startsWith("Wrong.") && q.markingNotes !== "Correct" && q.markingNotes !== "No answer" && (
                                <p className="text-xs text-[#43474f] italic mt-1">{stripScienceNoise(q.markingNotes)}</p>
                              )}
                            </div>
                          </div>

                          {/* AI Explain button + expandable elaboration */}
                          <div className="mt-2 ml-11">
                            {elaborations[q.id] ? (
                              <div>
                                <div className="flex items-center gap-3">
                                  <button
                                    onClick={() => setExpandedElabs(prev => {
                                      const next = new Set(prev);
                                      next.has(q.id) ? next.delete(q.id) : next.add(q.id);
                                      return next;
                                    })}
                                    className="flex items-center gap-1 text-xs font-bold text-[#003366] hover:underline"
                                  >
                                    <span className="material-symbols-outlined text-sm">{expandedElabs.has(q.id) ? "expand_less" : "expand_more"}</span>
                                    {expandedElabs.has(q.id) ? "Hide explanation" : "Show explanation"}
                                  </button>
                                  {sessionIsAdmin && expandedElabs.has(q.id) && elabDraft[q.id] === undefined && (
                                    <button
                                      onClick={() => setElabDraft(prev => ({ ...prev, [q.id]: elaborations[q.id] }))}
                                      className="text-xs font-bold text-[#43474f] hover:text-[#003366] hover:underline flex items-center gap-1"
                                      title="Edit AI explanation (admin only)"
                                    >
                                      <span className="material-symbols-outlined text-sm">edit</span>
                                      Edit
                                    </button>
                                  )}
                                </div>
                                {expandedElabs.has(q.id) && (
                                  <div className="mt-2 p-3 bg-[#eff4ff] rounded-xl space-y-3">
                                    {elabDiagrams[q.id]?.map((d, i) => (
                                      <div key={i}>
                                        {d.title && <p className="text-xs font-semibold text-[#003366] mb-1">{d.title}</p>}
                                        <BarDiagram diagram={d} />
                                      </div>
                                    ))}
                                    {sessionIsAdmin && elabDraft[q.id] !== undefined ? (
                                      <div className="space-y-2">
                                        <textarea
                                          value={elabDraft[q.id]}
                                          onChange={(e) => setElabDraft(prev => ({ ...prev, [q.id]: e.target.value }))}
                                          spellCheck={false}
                                          rows={Math.min(20, Math.max(4, elabDraft[q.id].split("\n").length + 1))}
                                          className="w-full text-sm font-mono p-3 rounded-lg border-2 border-[#003366]/30 focus:border-[#003366] outline-none bg-white text-[#0b1c30] leading-relaxed"
                                        />
                                        <div className="flex items-center gap-2">
                                          <button
                                            onClick={async () => {
                                              setElabSaving(q.id);
                                              try {
                                                const res = await fetch(`/api/exam/${id}/elaborate`, {
                                                  method: "PATCH",
                                                  headers: { "Content-Type": "application/json" },
                                                  body: JSON.stringify({
                                                    questionId: q.id,
                                                    solution: elabDraft[q.id],
                                                    diagrams: elabDiagrams[q.id] ?? [],
                                                  }),
                                                });
                                                if (!res.ok) {
                                                  alert(`Save failed: ${await res.text()}`);
                                                  return;
                                                }
                                                setElaborations(prev => ({ ...prev, [q.id]: elabDraft[q.id] }));
                                                setElabDraft(prev => {
                                                  const n = { ...prev };
                                                  delete n[q.id];
                                                  return n;
                                                });
                                              } finally {
                                                setElabSaving(null);
                                              }
                                            }}
                                            disabled={elabSaving === q.id}
                                            className="px-3 py-1.5 rounded-lg bg-[#003366] text-white text-xs font-bold disabled:opacity-50"
                                          >
                                            {elabSaving === q.id ? "Saving…" : "Save"}
                                          </button>
                                          <button
                                            onClick={() => setElabDraft(prev => {
                                              const n = { ...prev };
                                              delete n[q.id];
                                              return n;
                                            })}
                                            disabled={elabSaving === q.id}
                                            className="px-3 py-1.5 rounded-lg border border-[#c3c6d1] text-[#43474f] text-xs font-bold hover:bg-white/60"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <FormattedText text={elaborations[q.id]} className="text-sm text-[#43474f] leading-relaxed" />
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <button
                                onClick={() => { fetchElaboration(q.id); setExpandedElabs(prev => new Set(prev).add(q.id)); }}
                                disabled={elaborating === q.id}
                                className="flex items-center gap-1 text-xs font-bold text-[#003366] hover:underline disabled:opacity-50"
                              >
                                <span className="material-symbols-outlined text-sm">auto_awesome</span>
                                {elaborating === q.id ? "Generating..." : (isMathSciMcq(q) ? "Explain" : "AI Explain")}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  </div>
                  {/* Scanned page(s) at the bottom of the section
                      panel — lets the parent verify what Gemini saw
                      against the inline marking above. Covers every
                      typed English section. Comp-OEQ's split-screen
                      grid grows past its fixed-height stop in the lg
                      viewport — that's accepted; the page scrolls. */}
                  {(isGrammarCloze || isEditing || isCompCloze || isSynthesis || isCompOeq) && (() => {
                    const uniquePages = Array.from(
                      new Set(
                        sectionQuestions
                          .map(q => q.pageIndex)
                          .filter((p): p is number => typeof p === "number" && p >= 0)
                      )
                    ).sort((a, b) => a - b);
                    if (uniquePages.length === 0) return null;
                    return (
                      <div className={`mt-6 pt-6 border-t border-[#e5eeff] ${useSplitScreen ? "lg:col-span-2 lg:row-start-3" : ""}`}>
                        <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-3">
                          Scanned page{uniquePages.length > 1 ? "s" : ""} — what Gemini saw
                        </p>
                        <div className="space-y-3">
                          {uniquePages.map(pi => {
                            const sub = getSubmissionPage(pi);
                            return (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                key={pi}
                                src={`/api/exam/${id}/submission?page=${sub}`}
                                alt={`Scanned page ${sub + 1}`}
                                className="w-full h-auto rounded-xl border border-[#e5eeff]"
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* Current question card (standard per-question view) */}
            {currentQ && !isTypedSection && (() => {
              const isSkippedQ = currentQ.studentAnswer === "__SKIPPED__";
              const isCorrect = !isSkippedQ && (currentQ.marksAwarded ?? 0) >= (currentQ.marksAvailable ?? 1);
              const isPartial = !isSkippedQ && !isCorrect && (currentQ.marksAwarded ?? 0) > 0;
              const badgeBg = isSkippedQ ? "#e5eeff" : isCorrect ? "#d1fae5" : isPartial ? "#fef3c7" : "#ffdad6";
              const badgeText = isSkippedQ ? "#43474f" : isCorrect ? "#006c49" : isPartial ? "#633f00" : "#ba1a1a";
              // Check if this question has subparts with per-part answers shown inline
              const subs = currentQ.transcribedSubparts as { label: string }[] | null;
              const realSubLabels = subs?.filter(s => !s.label.startsWith("_")) ?? [];
              // Try studentAnswer first; fallback: extract from markingNotes
              // "Detected: ..." up to the first " | " section break, or end.
              // [\s\S] (not .) so multi-part OEQ detections that span newlines
              // ("(a) ...\n(b) ...") survive intact — the previous . variant
              // truncated at the first newline and lost part (b).
              const studentAnswerText = currentQ.studentAnswer
                || currentQ.markingNotes?.match(/^Detected:\s*([\s\S]+?)(?:\s*\||$)/)?.[1]?.trim()
                || null;
              const subLabels = realSubLabels.map(s => s.label.toLowerCase());
              const hasInlinePartAnswers = realSubLabels.length > 0 && (
                Object.keys(parsePartAnswers(studentAnswerText, subLabels)).length > 0 ||
                Object.keys(parsePartAnswers(currentQ.answer, subLabels)).length > 0
              );

              return (<>
              <div className="relative bg-[#eff4ff]/40 rounded-3xl p-5 lg:p-8 border border-[#e5eeff]">
                <div className="flex flex-col md:flex-row gap-5 lg:gap-8">
                  {/* Number badge */}
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center font-headline font-bold text-lg shrink-0"
                    style={{ backgroundColor: badgeBg, color: badgeText }}
                  >
                    {currentQ.questionNum}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Topic + marks */}
                    <div className="flex items-center gap-3 mb-4 flex-wrap">
                      {currentQ.marksAvailable !== null && (
                        editingMarks === currentQ.id && !isStudent ? (
                          <div className="flex items-center gap-1.5 bg-white rounded-full px-2 py-1 shadow-sm">
                            <button
                              onClick={() => { const v = Math.max(0, (currentQ.marksAwarded ?? 0) - 1); updateMarks(currentQ.id, v); }}
                              disabled={savingMarks || (currentQ.marksAwarded ?? 0) <= 0}
                              className="w-6 h-6 rounded-full bg-[#ffdad6] text-[#ba1a1a] flex items-center justify-center font-bold text-sm disabled:opacity-30"
                            >−</button>
                            <span className="text-xs font-bold text-[#001e40] min-w-[3rem] text-center">
                              {currentQ.marksAwarded ?? 0} / {currentQ.marksAvailable}
                            </span>
                            <button
                              onClick={() => { const v = Math.min(currentQ.marksAvailable!, (currentQ.marksAwarded ?? 0) + 1); updateMarks(currentQ.id, v); }}
                              disabled={savingMarks || (currentQ.marksAwarded ?? 0) >= currentQ.marksAvailable!}
                              className="w-6 h-6 rounded-full bg-[#d1fae5] text-[#006c49] flex items-center justify-center font-bold text-sm disabled:opacity-30"
                            >+</button>
                            <button onClick={() => setEditingMarks(null)} className="ml-1 text-[#43474f] hover:text-[#001e40]">
                              <span className="material-symbols-outlined text-sm">check</span>
                            </button>
                          </div>
                        ) : (
                          <span
                            onClick={() => { if (!isStudent) setEditingMarks(currentQ.id); }}
                            className={`px-3 py-1 bg-white rounded-full text-xs font-bold text-[#001e40] shadow-sm ${!isStudent ? "cursor-pointer hover:bg-[#e5eeff] transition-colors" : ""}`}
                          >
                            {currentQ.marksAwarded ?? 0} / {currentQ.marksAvailable} marks
                            {!isStudent && <span className="material-symbols-outlined text-[10px] ml-1 align-middle opacity-40">edit</span>}
                          </span>
                        )
                      )}
                      {isSkippedQ && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#43474f] bg-[#eff4ff] px-2 py-0.5 rounded-full">
                          <span className="material-symbols-outlined text-base">skip_next</span>
                          Skipped
                        </span>
                      )}
                      {isCorrect && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#006c49]">
                          <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                          Correct
                        </span>
                      )}
                      {!isCorrect && !isPartial && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#ba1a1a]">
                          <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>
                          Incorrect
                        </span>
                      )}
                      {isPartial && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#633f00]">
                          <span className="material-symbols-outlined text-base">remove_circle</span>
                          Partial
                        </span>
                      )}
                    </div>

                    {/* Quiz question text */}
                    {isQuiz && (currentQ.transcribedStem || (currentQ.transcribedSubparts as { label: string }[] | null)?.some(s => !s.label.startsWith("_"))) ? (
                      <div className="space-y-3 mb-5">
                        {(() => {
                          type SubpartEntry = { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null };
                          const allSubs = currentQ.transcribedSubparts as SubpartEntry[] | null;
                          const subRefMap: Record<string, string> = {};
                          if (allSubs) for (const sp of allSubs) if (sp.label.startsWith("_subref-")) subRefMap[sp.label.slice(8)] = sp.diagramBase64 ?? "";
                          const drawableDiagram = allSubs?.find(sp => sp.label === "_drawable")?.diagramBase64 ?? null;
                          const realSubs = allSubs
                            ? allSubs.filter(sp => !sp.label.startsWith("_")).map(sp => ({ ...sp, refImageBase64: subRefMap[sp.label] ?? sp.refImageBase64 ?? null }))
                            : null;
                          const toSrc = (b64: string) => b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
                          return (
                            <>
                              {currentQ.transcribedStem && (
                                <h3 className="font-headline text-lg lg:text-xl font-semibold text-[#001e40] leading-relaxed whitespace-pre-wrap">
                                  <MathText text={currentQ.transcribedStem} />
                                </h3>
                              )}
                              {/* Show question image only when stem is missing AND there's no clean
                                  extract data (subparts or diagram) — avoids showing raw scan alongside
                                  cleanly extracted content */}
                              {!currentQ.transcribedStem && currentQ.imageData && !currentQ.diagramImageData && !(realSubs && realSubs.length > 0) && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={currentQ.imageData} alt={`Question ${currentQ.questionNum}`} className="w-full rounded-xl border border-[#e5eeff]" />
                              )}
                              {/* Static reference diagram — show even when the
                                  question also has a drawable canvas background.
                                  Quiz page renders both too; review was hiding
                                  the static diagram whenever drawable was present
                                  which lost the diagram for Q7/Q8 in tests. */}
                              {currentQ.diagramImageData && (() => {
                                const k = `question:${currentQ.id}:diagram`;
                                return (
                                  <div className="w-full rounded-xl border border-[#e5eeff] overflow-hidden relative select-none">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={toSrc(currentQ.diagramImageData)}
                                      alt="Diagram"
                                      className="w-full block pointer-events-none select-none"
                                      draggable={false}
                                      style={{ WebkitTouchCallout: "none", WebkitUserDrag: "none" } as React.CSSProperties}
                                    />
                                    <ReviewPenOverlay
                                      key={k}
                                      paperId={id}
                                      storageKey={k}
                                      initialDataUrl={data.reviewAnnotations?.[k] ?? null}
                                      readOnly={isStudent}
                                      onSaved={handlePenSaved}
                                      scaleToFit
                                    />
                                  </div>
                                );
                              })()}
                              {/* drawableDiagram is the BLANK canvas background
                                  the student drew on. The drawn version comes
                                  through as a SubmissionImage further down, so
                                  rendering this here just doubles up with a
                                  blank copy. Dropped per parent feedback. */}
                              {/* MCQ options — table format. Matches the
                                  quiz-player style: black 2-px borders on
                                  every cell (border-collapse), header in a
                                  light fill, rows tinted by outcome (green
                                  for correct row, red for the student's
                                  pick when wrong). Radio in the leading
                                  column with the option number so the
                                  student's pick is unmistakable. */}
                              {currentQ.transcribedOptionTable
                                && Array.isArray(currentQ.transcribedOptionTable.rows)
                                && currentQ.transcribedOptionTable.rows.length === 4 && (
                                <div className="overflow-x-auto mt-2">
                                  <table className="w-full text-base lg:text-lg border-collapse border-2 border-black">
                                    <thead className="bg-slate-50">
                                      <tr>
                                        <th className="px-3 py-3 text-left font-headline font-bold text-black border-2 border-black w-20">Option</th>
                                        {currentQ.transcribedOptionTable.columns.map((c, i) => (
                                          <th key={i} className="px-4 py-3 text-left font-headline font-bold text-black border-2 border-black">
                                            <MathText text={c} />
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {currentQ.transcribedOptionTable.rows.map((row, ri) => {
                                        const optNum = String(ri + 1);
                                        const isOptCorrect = mcqAnswerHead(currentQ.answer) === optNum;
                                        const isSelected = currentQ.studentAnswer === optNum;
                                        const rowBg = isOptCorrect ? "bg-[#6cf8bb]/30" : isSelected ? "bg-[#ffdad6]" : "";
                                        return (
                                          <tr key={ri} className={rowBg}>
                                            <td className="px-3 py-3 align-middle border-2 border-black">
                                              <div className="flex items-center gap-2">
                                                <input
                                                  type="radio"
                                                  checked={isSelected}
                                                  readOnly
                                                  className={`w-5 h-5 pointer-events-none ${isOptCorrect ? "accent-[#006c49]" : isSelected ? "accent-[#ba1a1a]" : "accent-[#001e40]"}`}
                                                />
                                                <span className={`font-headline font-bold text-base ${isOptCorrect ? "text-[#006c49]" : isSelected ? "text-[#ba1a1a]" : "text-black"}`}>({ri + 1})</span>
                                              </div>
                                            </td>
                                            {row.map((cell, ci) => (
                                              <td key={ci} className="px-4 py-3 align-middle text-[#0b1c30] font-medium border-2 border-black">
                                                <MathText text={cell} />
                                              </td>
                                            ))}
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              {/* MCQ options — image grid (hidden when a
                                  table is in play; the three branches are
                                  mutually exclusive even if the underlying
                                  row carries leftover legacy text/image
                                  arrays). */}
                              {!currentQ.transcribedOptionTable && currentQ.transcribedOptionImages && currentQ.transcribedOptionImages.some(img => img) && (
                                <div className="grid grid-cols-2 gap-3 mt-2">
                                  {[0, 1, 2, 3].map(i => {
                                    const optNum = String(i + 1);
                                    const isOptCorrect = mcqAnswerHead(currentQ.answer) === optNum;
                                    const isSelected = currentQ.studentAnswer === optNum;
                                    const imgSrc = currentQ.transcribedOptionImages![i];
                                    return (
                                      <div key={i} className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 ${
                                        isOptCorrect ? "bg-[#6cf8bb]/20 border-[#006c49]/40" : isSelected ? "bg-[#ffdad6] border-[#ba1a1a]/40" : "bg-[#eff4ff] border-transparent"
                                      }`}>
                                        <span className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                                          isOptCorrect ? "bg-[#006c49] text-white" : isSelected ? "bg-[#ba1a1a] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                                        }`}>{i + 1}</span>
                                        {imgSrc ? (
                                          // eslint-disable-next-line @next/next/no-img-element
                                          <img src={`data:image/jpeg;base64,${imgSrc}`} alt={`Option ${i + 1}`} className="w-full rounded" />
                                        ) : null}
                                        {isOptCorrect && <span className="text-[10px] font-bold text-[#006c49]">Correct</span>}
                                        {!isOptCorrect && isSelected && <span className="text-[10px] font-bold text-[#ba1a1a]">Your answer</span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {/* MCQ options — text list (same mutual-
                                  exclusion as the image branch above). */}
                              {!currentQ.transcribedOptionTable && currentQ.transcribedOptions && currentQ.transcribedOptions.length > 0 && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                                  {currentQ.transcribedOptions.map((opt, i) => {
                                    const optNum = String(i + 1);
                                    const isOptCorrect = mcqAnswerHead(currentQ.answer) === optNum;
                                    const isSelected = currentQ.studentAnswer === optNum;
                                    return (
                                      <div key={i} className={`p-4 rounded-2xl flex items-center justify-between gap-3 ${
                                        isOptCorrect ? "bg-[#6cf8bb]/20 border border-[#006c49]/20" : isSelected ? "bg-[#ffdad6] border border-[#ba1a1a]/20" : "bg-white border border-[#e5eeff]"
                                      }`}>
                                        <div className="flex items-center gap-3 min-w-0">
                                          <span className={`w-10 h-10 rounded-full flex items-center justify-center font-headline font-bold shrink-0 ${
                                            isOptCorrect ? "bg-[#006c49] text-white" : isSelected ? "bg-[#ba1a1a] text-white" : "bg-[#eff4ff] text-[#001e40]"
                                          }`}>{i + 1}</span>
                                          <span className={`font-headline font-semibold text-base ${isOptCorrect || isSelected ? "text-[#001e40]" : "text-[#43474f]"}`}><MathText text={opt} /></span>
                                        </div>
                                        {isOptCorrect && isSelected && <span className="text-xs font-bold text-[#006c49] shrink-0">Correct</span>}
                                        {isOptCorrect && !isSelected && <span className="material-symbols-outlined text-[#006c49] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>}
                                        {!isOptCorrect && isSelected && <span className="material-symbols-outlined text-[#ba1a1a] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {/* Subparts with per-part answers */}
                              {realSubs && realSubs.length > 0 && (() => {
                                const spLabels = realSubs.map(s => s.label.toLowerCase());
                                const studentParts = parsePartAnswers(studentAnswerText, spLabels);
                                const answerParts = parsePartAnswers(currentQ.answer, spLabels);
                                const hasPartAnswers = Object.keys(studentParts).length > 0 || Object.keys(answerParts).length > 0;
                                // Per-subpart marksAvailable comes from a "[N]" / "[N marks]"
                                // suffix in the subpart text (filled in by the
                                // /admin/subpart-marks tool). Used to detect
                                // partial — if awarded < available, status is "partial".
                                const partAvailableMap: Record<string, number> = {};
                                for (const sp of realSubs) {
                                  const m = String(sp.text ?? "").match(/\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i);
                                  if (m) partAvailableMap[sp.label.toLowerCase()] = parseInt(m[1], 10);
                                }
                                // Parse marking notes for per-part correctness.
                                // Tristate: full | partial | none. Yellow box
                                // for partial mirrors the section-header chip
                                // palette (#fef3c7 / #633f00).
                                type PartStatus = "full" | "partial" | "none";
                                const notes = currentQ.markingNotes ?? "";
                                const partStatusMap: Record<string, PartStatus> = {};
                                // Skip the "Detected: ..." prefix — only the
                                // part after the " | " separator is actual
                                // marking commentary. The detected echo
                                // mentions (a)/(b) too (it parrots the
                                // question structure) which would otherwise
                                // be parsed as grading sections.
                                const sepIdx = notes.indexOf(" | ");
                                const commentary = sepIdx >= 0 ? notes.slice(sepIdx + 3) : notes;
                                // Require an explicit section header: optional
                                // "Part " + "(X)" + ":". The colon is what
                                // separates a real header from in-prose
                                // mentions like "Part (b) was left blank".
                                const sectionRe = /(?:^|\n|\.\s+|;\s+)(?:Part\s+)?\(([a-z])\)\s*:/gi;
                                const sectionMatches = [...commentary.matchAll(sectionRe)].filter(m => spLabels.includes(m[1].toLowerCase()));
                                for (let i = 0; i < sectionMatches.length; i++) {
                                  const m = sectionMatches[i];
                                  const label = m[1].toLowerCase();
                                  const start = m.index! + m[0].length;
                                  const end = i + 1 < sectionMatches.length ? sectionMatches[i + 1].index! : commentary.length;
                                  const section = commentary.slice(start, end);
                                  // Pattern A: explicit mark indicator —
                                  //   "X/Y marks", "X out of Y marks", "X marks out of Y".
                                  // Tight: "marks?" must appear next to the
                                  // X/Y so we don't latch onto unrelated
                                  // ratios like "2 of 3 answers" or fractions
                                  // like "2/3 of the area" in working text.
                                  const outOfMatch = section.match(
                                    /(\d+(?:\.\d+)?)\s*marks?\s+out of\s+(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:\/|\s+out of\s+)\s*(\d+(?:\.\d+)?)\s*marks?\b/i,
                                  );
                                  if (outOfMatch) {
                                    const awarded = parseFloat(outOfMatch[1] ?? outOfMatch[3]);
                                    const available = parseFloat(outOfMatch[2] ?? outOfMatch[4]);
                                    partStatusMap[label] = awarded === 0 ? "none" : awarded >= available ? "full" : "partial";
                                    continue;
                                  }
                                  // Pattern B: explicit "partial" keyword
                                  if (/\bpartial(ly)?\b/i.test(section)) {
                                    partStatusMap[label] = "partial";
                                    continue;
                                  }
                                  // Pattern C: sum mark-earning verbs in the
                                  // section. Markers use both "Awarded N
                                  // marks" (part total) and "earning N
                                  // mark"/"earned N marks" (sub-element
                                  // credit) — when a part splits into
                                  // sub-elements, summing recovers the
                                  // intended part total. Clamp to the
                                  // subpart cap if known.
                                  const awardMatches = [...section.matchAll(/\b(?:awarded|earning|earned|scoring|scored|gaining|gained|given)\s+(\d+(?:\.\d+)?)\s*marks?\b/gi)];
                                  if (awardMatches.length > 0) {
                                    let awarded = awardMatches.reduce((s, mm) => s + parseFloat(mm[1]), 0);
                                    const avail = partAvailableMap[label];
                                    if (avail != null) awarded = Math.min(awarded, avail);
                                    if (awarded === 0) { partStatusMap[label] = "none"; continue; }
                                    if (!Number.isInteger(awarded)) { partStatusMap[label] = "partial"; continue; }
                                    if (avail != null) {
                                      partStatusMap[label] = awarded >= avail ? "full" : "partial";
                                    } else {
                                      partStatusMap[label] = "full";
                                    }
                                    continue;
                                  }
                                  // Keyword fallbacks — only run when neither
                                  // an "X/Y marks" nor an "Awarded N marks"
                                  // pattern matched, so a grading section
                                  // that mentions "incorrect calculations"
                                  // alongside "Awarded 2 marks" still wins
                                  // via Pattern C.
                                  if (/\b(no answer|blank|not provided|no written|did not|missing)\b/i.test(section)) {
                                    partStatusMap[label] = "none";
                                    continue;
                                  }
                                  if (/\b(incorrect|wrong)\b/i.test(section)) {
                                    partStatusMap[label] = "none";
                                    continue;
                                  }
                                  if (/\b(correct|matches|accepted|full marks)\b/i.test(section)) {
                                    partStatusMap[label] = "full";
                                    continue;
                                  }
                                }
                                return (
                                  <div className="space-y-4 mt-2">
                                    {realSubs.map((sp) => {
                                      // Skip rendering the canvas-background
                                      // diagram when a SubmissionImage will
                                      // render below — the submission already
                                      // includes the same diagram with the
                                      // student's ink baked in. Reference
                                      // images (refImageBase64) are different —
                                      // they're answer templates / question
                                      // figures that the submission doesn't
                                      // show, so keep those.
                                      const hasSubmission = isQuiz && currentQOeqIndex >= 0;
                                      const imgSrc = sp.refImageBase64
                                        ? toSrc(sp.refImageBase64)
                                        : (sp.diagramBase64 && !hasSubmission)
                                          ? toSrc(sp.diagramBase64)
                                          : null;
                                      const partStudent = studentParts[sp.label.toLowerCase()];
                                      const partAnswer = answerParts[sp.label.toLowerCase()];
                                      // Tristate: parsed from notes when possible,
                                      // else fall back to comparing student vs
                                      // expected per part. Exact match → full,
                                      // shared significant words → partial,
                                      // blank/no overlap → none. Word overlap
                                      // catches cases like Q9 (a) where one
                                      // half of a two-part answer is right and
                                      // the other half is blank but the marker
                                      // notes don't carry an explicit per-part
                                      // breakdown.
                                      const partStatus: PartStatus = (() => {
                                        if (sp.label.toLowerCase() in partStatusMap) return partStatusMap[sp.label.toLowerCase()];
                                        if (!partAnswer || !partStudent) return isCorrect ? "full" : "none";
                                        const norm = (s: string) => s.toLowerCase().replace(/\s/g, "");
                                        if (norm(partStudent) === norm(partAnswer)) return "full";
                                        const stripped = partStudent.toLowerCase().trim();
                                        if (!stripped || /^(blank|none|empty|skipped|no answer|n\/?a|-)$/i.test(stripped)) return "none";
                                        const tokenize = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
                                        const studentWords = tokenize(partStudent);
                                        const answerWords = tokenize(partAnswer);
                                        let overlap = 0;
                                        for (const w of answerWords) if (studentWords.has(w)) overlap++;
                                        if (overlap === 0) return "none";
                                        if (overlap >= answerWords.size) return "full";
                                        return "partial";
                                      })();
                                      return (
                                        <div key={sp.label} className="space-y-2">
                                          <p className="text-sm text-[#0b1c30]">
                                            <span className="font-bold text-[#001e40]">{formatSubpartLabel(sp.label)}</span> {sp.text}
                                          </p>
                                          {imgSrc && (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={imgSrc} alt={`(${sp.label}) diagram`} className="w-full rounded-xl border border-[#e5eeff]" />
                                          )}
                                          {/* Per-subpart submission image (falls back to combined) */}
                                          {isQuiz && currentQOeqIndex >= 0 && (() => {
                                            // Hide canvas when the overall question was blank
                                            // (mirrors the non-subpart case below). Subparts
                                            // with their own diagram (drawable) still render.
                                            const sa = (currentQ.studentAnswer ?? "").trim().toLowerCase();
                                            const isBlankAnswer = !currentQ.studentAnswer
                                              || sa === "__skipped__"
                                              || sa === "no answer detected"
                                              || sa.startsWith("no answer")
                                              || isAllPartsMissing(sa);
                                            if (isBlankAnswer && !sp.diagramBase64 && !sp.refImageBase64) return null;
                                            const overlayKey = `question:${currentQ.id}:${sp.label}`;
                                            // Both drawable AND non-drawable subparts now use
                                            // natural image aspect AND auto-trim. The trim only
                                            // collapses uniform white edges, so printed diagrams
                                            // survive intact while trailing blank scratchpad
                                            // below the diagram (or below the student's writing)
                                            // gets cropped off. Previously drawable subparts
                                            // skipped trim out of caution, but in practice the
                                            // diagram has enough non-white content for sharp.trim
                                            // to recognise its bounds.
                                            return (
                                              <div
                                                className="w-full rounded-2xl border border-[#e5eeff] overflow-hidden bg-white relative"
                                              >
                                                <SubmissionImage
                                                  src={`/api/exam/${id}/submission?page=${currentQSubmissionPage}&subpart=${sp.label.toLowerCase()}`}
                                                  alt={`Written answer for (${sp.label})`}
                                                  className="block"
                                                  imgStyle={{ width: "100%", height: "auto", display: "block" }}
                                                  onError={(e) => {
                                                    const img = e.target as HTMLImageElement;
                                                    if (sp === realSubs[0] && !img.dataset.fallback) {
                                                      img.dataset.fallback = "1";
                                                      img.src = `/api/exam/${id}/submission?page=${currentQSubmissionPage}`;
                                                    } else if (img.dataset.fallback) {
                                                      img.style.display = "none";
                                                    } else {
                                                      img.style.display = "none";
                                                    }
                                                  }}
                                                />
                                                <ReviewPenOverlay
                                                  key={overlayKey}
                                                  paperId={id}
                                                  storageKey={overlayKey}
                                                  initialDataUrl={data.reviewAnnotations?.[overlayKey] ?? null}
                                                  readOnly={isStudent}
                                                  onSaved={handlePenSaved}
                                                  scaleToFit
                                                />
                                              </div>
                                            );
                                          })()}
                                          {/* Detected answer: per-part if parsed, or raw fallback for single-subpart questions */}
                                          {(() => {
                                            const detected = partStudent || (!hasPartAnswers && realSubs.length === 1 && studentAnswerText) || null;
                                            if (!detected) return null;
                                            const cleaned = cleanDetectedAnswer(detected);
                                            return (
                                              <div className={`text-sm leading-relaxed rounded-xl p-3 ${
                                                partStatus === "full"
                                                  ? "bg-[#6cf8bb]/20 text-[#006c49]"
                                                  : partStatus === "partial"
                                                    ? "bg-[#fef3c7] text-[#633f00]"
                                                    : "bg-[#ffdad6] text-[#93000a]"
                                              }`}>
                                                <span className="text-[9px] font-bold uppercase tracking-wider opacity-60 block mb-0.5">Detected Answer</span>
                                                {cleaned}
                                              </div>
                                            );
                                          })()}
                                          {/* Correct answer: per-part if parsed, or raw fallback for single-subpart questions */}
                                          {(() => {
                                            const correct = partAnswer || (!hasPartAnswers && realSubs.length === 1 && currentQ.answer) || null;
                                            if (!correct) return null;
                                            return (
                                              <div className="text-sm text-[#0b1c30] leading-relaxed rounded-xl bg-white p-3 border border-[#e5eeff]">
                                                <span className="text-[9px] font-bold uppercase tracking-wider text-[#43474f] opacity-60 block mb-0.5">Correct Answer</span>
                                                <FormattedText text={correct.replace(/\s*\|\s*/g, "\n")} className="whitespace-pre-line" />
                                              </div>
                                            );
                                          })()}
                                        </div>
                                      );
                                    })}
                                    {/* Fallback: show full raw answer when per-part parsing found nothing */}
                                    {!hasPartAnswers && currentQ.answer && (
                                      <div className="text-sm text-[#0b1c30] leading-relaxed rounded-xl bg-white p-3 border border-[#e5eeff]">
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-[#43474f] opacity-60 block mb-0.5">Correct Answer</span>
                                        <FormattedText text={currentQ.answer.replace(/\s*\|\s*/g, "\n")} className="whitespace-pre-line" />
                                      </div>
                                    )}
                                    {/* Answer diagram (if any) — per-part text answers are already shown above */}
                                    {currentQ.answerImageData && (
                                      <div className="mt-3">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={currentQ.answerImageData} alt="Answer diagram" className="max-w-full rounded-xl border border-[#e5eeff]" />
                                      </div>
                                    )}
                                    {/* Marking notes for subpart questions */}
                                    {currentQ.markingNotes && (
                                      <div className="mt-2">
                                        <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Marking Notes</p>
                                        <p className="text-sm text-[#43474f] leading-relaxed">
                                          {renderMarkingNotes(currentQ.markingNotes)}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            </>
                          );
                        })()}
                      </div>
                    ) : currentQ.imageData && (isQuiz || submissionPageCount === 0) ? (
                      // Master question crop. We hide it for exam papers
                      // that have a submission scan, because the same
                      // question content is already visible in the
                      // student's marked-up scanned page rendered below.
                      <div className="mb-5 rounded-2xl overflow-hidden border border-[#e5eeff]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={currentQ.imageData} alt={`Question ${currentQ.questionNum}`} className="w-full h-auto" />
                      </div>
                    ) : null}

                    {/* Quiz OEQ (non-subpart): stacked layout — written answer, detected, correct */}
                    {isQuiz && currentQOeqIndex >= 0 && !currentQ.transcribedOptions && !currentQ.transcribedOptionImages && !currentQ.transcribedOptionTable && !hasInlinePartAnswers && realSubLabels.length === 0 && (
                      <div className="space-y-4 mb-4">
                        {/* Written answer image */}
                        {(() => {
                          // Hide the entire 'Written Answer' canvas when the
                          // marker recorded the question as blank — no point
                          // rendering a 450-pixel-tall white box that adds
                          // nothing. Catches 'No answer detected' (BLUE INK
                          // CHECK in marking.ts) AND multi-part shapes like
                          // '(a) missing | (b) missing' where the marker
                          // tagged every sub-part as blank.
                          const sa = (currentQ.studentAnswer ?? "").trim().toLowerCase();
                          const hasDrawable = !!(currentQ.transcribedSubparts as { label: string }[] | null)?.find(s => s.label === "_drawable");
                          const isBlankAnswer = !currentQ.studentAnswer
                            || sa === "__skipped__"
                            || sa === "no answer detected"
                            || sa.startsWith("no answer")
                            || isAllPartsMissing(sa);
                          if (isBlankAnswer && !hasDrawable) return null;
                          const overlayKey = `question:${currentQ.id}`;
                          // Wrapper height comes from the trimmed image's
                          // natural aspect (height: auto). Server-side
                          // trim runs for both drawable and non-drawable
                          // canvases — the threshold-30 sharp.trim only
                          // collapses uniform white edges, so a printed
                          // background diagram survives intact while the
                          // trailing blank scratchpad below it gets cropped.
                          return (
                            <div>
                              <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Written Answer</p>
                              <div className="rounded-2xl overflow-hidden border border-[#e5eeff] bg-white relative">
                                <SubmissionImage
                                  src={`/api/exam/${id}/submission?page=${currentQSubmissionPage}`}
                                  alt={`Written answer for Q${currentQ.questionNum}`}
                                  className="block"
                                  imgStyle={{ width: "100%", height: "auto", display: "block" }}
                                />
                                <ReviewPenOverlay
                                  key={overlayKey}
                                  paperId={id}
                                  storageKey={overlayKey}
                                  initialDataUrl={data.reviewAnnotations?.[overlayKey] ?? null}
                                  readOnly={isStudent}
                                  onSaved={handlePenSaved}
                                  scaleToFit
                                />
                              </div>
                            </div>
                          );
                        })()}
                        {/* Detected answer */}
                        {studentAnswerText && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Detected Answer</p>
                            <div className={`text-sm leading-relaxed rounded-2xl p-4 whitespace-pre-wrap ${
                              isCorrect ? "bg-[#6cf8bb]/20 text-[#006c49]" : "bg-[#ffdad6] text-[#93000a]"
                            }`}>
                              {cleanDetectedAnswer(studentAnswerText)}
                            </div>
                          </div>
                        )}
                        {/* Correct answer */}
                        {(currentQ.answer || currentQ.answerImageData) && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Correct Answer</p>
                            {currentQ.answer && (
                              <div className="text-sm text-[#0b1c30] leading-relaxed rounded-2xl bg-white p-4 border border-[#e5eeff]">
                                {renderWithNewlines(currentQ.answer)}
                              </div>
                            )}
                            {currentQ.answerImageData && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={currentQ.answerImageData} alt="Answer diagram" className="mt-2 max-w-full rounded-xl border border-[#e5eeff]" />
                            )}
                          </div>
                        )}
                        {/* Marking notes */}
                        {currentQ.markingNotes && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Marking Notes</p>
                            <div className="text-sm text-[#43474f] leading-relaxed whitespace-pre-wrap">
                              {renderMarkingNotes(currentQ.markingNotes)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Exam paper: Submission image + solution side-by-side */}
                    {!isQuiz && (
                    <div className="md:flex gap-5">
                      {!currentQ.transcribedOptions && !currentQ.transcribedOptionImages && !currentQ.transcribedOptionTable && (
                        <div className="md:w-1/2 md:shrink-0 mb-4 md:mb-0 rounded-2xl overflow-hidden border border-[#e5eeff] relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/exam/${id}/submission?page=${effectiveSubmissionPage}`}
                            alt={`Submission page for Q${currentQ.questionNum}`}
                            className="w-full h-auto block"
                          />
                          {/* Parent red-pen overlay on the scanned page.
                              Saved annotations are keyed per submission
                              page index and replayed on the export PDF. */}
                          <ReviewPenOverlay
                            key={`submission:${effectiveSubmissionPage}`}
                            paperId={id}
                            storageKey={`submission:${effectiveSubmissionPage}`}
                            initialDataUrl={data.reviewAnnotations?.[`submission:${effectiveSubmissionPage}`] ?? null}
                            readOnly={isStudent}
                            onSaved={handlePenSaved}
                            scaleToFit
                          />
                          {submissionPageCount > 1 && (
                            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/50 rounded-full px-3 py-1">
                              <button
                                onClick={() => setSubmissionPageOverride(Math.max(0, effectiveSubmissionPage - 1))}
                                disabled={effectiveSubmissionPage === 0}
                                className="text-white/80 hover:text-white disabled:text-white/30"
                              >
                                <span className="material-symbols-outlined text-sm">chevron_left</span>
                              </button>
                              <span className="text-[10px] text-white/80 min-w-[2rem] text-center">{effectiveSubmissionPage + 1}/{submissionPageCount}</span>
                              <button
                                onClick={() => setSubmissionPageOverride(Math.min(submissionPageCount - 1, effectiveSubmissionPage + 1))}
                                disabled={effectiveSubmissionPage === submissionPageCount - 1}
                                className="text-white/80 hover:text-white disabled:text-white/30"
                              >
                                <span className="material-symbols-outlined text-sm">chevron_right</span>
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Solutions panel */}
                      <div className="flex-1 space-y-4">
                        {/* OEQ typed answer */}
                        {studentAnswerText && !currentQ.transcribedOptions && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Detected Answer</p>
                            <div className={`text-sm leading-relaxed rounded-2xl p-4 whitespace-pre-wrap ${
                              isCorrect ? "bg-[#6cf8bb]/20 text-[#006c49]" : "bg-[#ffdad6] text-[#93000a]"
                            }`}>
                              {cleanDetectedAnswer(studentAnswerText)}
                            </div>
                          </div>
                        )}

                        {/* Correct answer */}
                        {(currentQ.answer || currentQ.answerImageData) && !(isQuiz && currentQ.transcribedOptions) && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Correct Answer</p>
                            {currentQ.answer && (
                              <div className="text-sm text-[#0b1c30] leading-relaxed max-h-48 overflow-y-auto rounded-2xl bg-white p-4 border border-[#e5eeff]">
                                {renderWithNewlines(currentQ.answer)}
                              </div>
                            )}
                            {currentQ.answerImageData && (
                              <img
                                src={currentQ.answerImageData}
                                alt="Answer diagram"
                                className="mt-2 max-w-full rounded-xl border border-[#e5eeff]"
                              />
                            )}
                          </div>
                        )}

                        {/* Marking notes */}
                        {currentQ.markingNotes && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Marking Notes</p>
                            <div className="text-sm text-[#43474f] leading-relaxed whitespace-pre-wrap">
                              {renderMarkingNotes(currentQ.markingNotes)}
                            </div>
                          </div>
                        )}

                      </div>
                    </div>
                    )}

                    {/* English quiz: scanned page at the bottom of every
                        question card (MCQ + OEQ) so the parent can verify
                        the detected answer against what the student
                        actually wrote. Non-English papers already get a
                        side-by-side submission image up top for OEQ; we
                        skip here to avoid double-showing. */}
                    {isQuiz && (paperSubject ?? "").toLowerCase().includes("english") && currentQ.pageIndex >= 0 && (() => {
                      const sub = getSubmissionPage(currentQ.pageIndex);
                      return (
                        <div className="mt-6 pt-5 border-t border-[#e5eeff]">
                          <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-3">
                            Scanned page — Q{currentQ.questionNum}
                          </p>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/exam/${id}/submission?page=${sub}`}
                            alt={`Scanned page for Q${currentQ.questionNum}`}
                            className="w-full h-auto rounded-xl border border-[#e5eeff]"
                          />
                        </div>
                      );
                    })()}

                    {/* Flag toggle — bottom center */}
                    <div className="mt-6 pt-5 border-t border-[#e5eeff] flex justify-center">
                      <button
                        onClick={() => onFlagClick(currentQ.id)}
                        disabled={flagging === currentQ.id}
                        className={`flex flex-col items-center gap-1 transition-all disabled:opacity-50 group ${
                          flaggedIds.has(currentQ.id) ? "text-[#ba1a1a]" : "text-[#43474f] opacity-60 hover:opacity-100 hover:text-[#001e40]"
                        }`}
                      >
                        {/* Triangle on mobile, flag on desktop */}
                        <span
                          className="material-symbols-outlined text-3xl lg:hidden transform rotate-180"
                          style={flaggedIds.has(currentQ.id) ? { fontVariationSettings: "'FILL' 1" } : {}}
                        >
                          change_history
                        </span>
                        <span
                          className="material-symbols-outlined text-3xl hidden lg:block"
                          style={flaggedIds.has(currentQ.id) ? { fontVariationSettings: "'FILL' 1" } : {}}
                        >
                          flag
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-wider">
                          {flaggedIds.has(currentQ.id) ? "Flagged" : "Flag for Review"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* AI Elaboration — separate section below question card */}
              {currentQ.marksAwarded !== null && (
                <div className="mt-4">
                  {elaborations[currentQ.id] ? (
                    <div className="bg-[#eff4ff]/40 rounded-3xl p-5 lg:p-8 border border-[#e5eeff] space-y-4">
                      <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">{isMathSciMcq(currentQ) ? "Explanation" : "AI Explanation"}</p>
                      {elabDiagrams[currentQ.id]?.map((d, i) => (
                        <div key={i}>
                          {d.title && <p className="text-xs font-semibold text-[#003366] mb-1">{d.title}</p>}
                          <BarDiagram diagram={d} />
                        </div>
                      ))}
                      <FormattedText text={elaborations[currentQ.id]} className="text-base text-[#43474f] leading-relaxed whitespace-pre-line" />
                    </div>
                  ) : (
                    <button
                      onClick={() => fetchElaboration(currentQ.id)}
                      disabled={elaborating === currentQ.id}
                      className="w-full h-14 bg-gradient-to-r from-[#001e40] to-[#003366] hover:from-[#003366] hover:to-[#001e40] text-white rounded-2xl flex items-center justify-center gap-3 font-headline font-bold transition-all shadow-md active:scale-95 disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined">psychology_alt</span>
                      {elaborating === currentQ.id ? (
                        <span className="flex items-center gap-2">
                          <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white inline-block" />
                          Generating in background...
                        </span>
                      ) : "AI Elaboration"}
                    </button>
                  )}
                </div>
              )}
              </>);
            })()}
          </div>
        )}
      </div>

      {/* Sticker picker modal */}
      {showStickerPicker && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[200]" onClick={() => setShowStickerPicker(false)}>
          <div className="bg-white rounded-3xl p-8 shadow-2xl grid grid-cols-2 gap-6" onClick={e => e.stopPropagation()}>
            <p className="col-span-2 text-center font-headline font-bold text-[#001e40] text-lg">Pick a sticker!</p>
            {["unicorn_t.PNG", "trex_t.PNG", "pizza_t.PNG", "wizard_t.PNG", "star_t.PNG", "rocket_t.PNG", "cat_t.PNG"].map(s => (
              <button key={s} onClick={() => saveSticker(s)} className="hover:scale-110 transition-transform p-4 rounded-2xl hover:bg-[#eff4ff]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/stickers/thumbs/${s}`} alt={s.replace("_t.PNG", "")} className="w-24 h-24 object-contain" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Export-marked progress modal — covers the screen while the
          server runs Gemini classifications + builds the PDF. ~5-10s
          on a typical 19-question paper. Uncloseable on purpose; if it
          fails the alert in the click handler will surface the error. */}
      {exporting && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-sm w-full flex flex-col items-center gap-4">
            <div className="w-12 h-12 rounded-full border-4 border-[#dce9ff] border-t-[#003366] animate-spin" />
            <p className="font-headline font-extrabold text-lg text-[#001e40]">Generating annotated marked paper</p>
            <p className="text-sm text-[#43474f] text-center">10–15 seconds</p>
          </div>
        </div>
      )}

      {/* Flag-with-note popup. Mounts only while a question is awaiting
          flag — onJustFlag / onTextFlagged finalise the toggle, then
          we close the modal by clearing the question id. */}
      <FlagVoiceModal
        paperId={id}
        questionId={flagModalQuestionId ?? ""}
        userId={userId}
        open={flagModalQuestionId !== null}
        onClose={() => setFlagModalQuestionId(null)}
        onJustFlag={() => {
          if (flagModalQuestionId) void toggleFlag(flagModalQuestionId);
        }}
        onTextFlagged={(text) => {
          if (flagModalQuestionId) void toggleFlag(flagModalQuestionId, text);
        }}
        onVoiceFlagged={() => {
          // The /api/exam/[id]/flag/voice endpoint sets flagged=true
          // server-side, so just sync local state.
          if (flagModalQuestionId) {
            const qid = flagModalQuestionId;
            setFlaggedIds((prev) => new Set(prev).add(qid));
          }
        }}
      />
    </div>
  );
}

/** Renders rich text with tables, bold, tick boxes for review */
function ReviewRichText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-0.5">
      {lines.map((line, li) => {
        const trimmed = line.trim();
        if (!trimmed) return <br key={li} />;
        if (trimmed.match(/^\|[\s-:|]+\|$/)) return null;
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
          const cells = trimmed.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
          return (
            <div key={li} className="flex gap-1 my-0.5">
              {cells.map((cell, ci) => (
                <span key={ci} className="flex-1 text-center text-xs font-medium text-[#001e40] bg-[#eff4ff] rounded px-2 py-1 border border-[#d3e4fe]">
                  {cell ? <MathText text={cell} /> : "—"}
                </span>
              ))}
            </div>
          );
        }
        if (trimmed.match(/^\[[ x✓✗]\]\s/i)) {
          const checked = trimmed.match(/^\[[x✓]\]/i);
          const content = trimmed.replace(/^\[[ x✓✗]\]\s*/i, "");
          return (
            <div key={li} className="flex items-center gap-2 text-sm text-[#001e40] my-0.5">
              <span>{checked ? "☑" : "☐"}</span>
              <MathText text={content} />
            </div>
          );
        }
        if (trimmed.match(/^_{3,}$/)) return <div key={li} className="border-b border-slate-300 my-1 w-48" />;
        return <p key={li} className="text-sm text-[#001e40] leading-relaxed"><MathText text={trimmed} /></p>;
      })}
    </div>
  );
}

function renderBoldInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    parts.push(<strong key={m.index} className="font-bold">{m[1]}</strong>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : text;
}
