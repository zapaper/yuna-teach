"use client";

import { Suspense, useEffect, useMemo, useState, useRef, useImperativeHandle, forwardRef, use, Fragment } from "react";
import MathText from "@/components/MathText";
import { useRouter, useSearchParams } from "next/navigation";
import EnglishQuizSection from "@/components/EnglishQuizSection";
import ChineseQuizSection from "@/components/ChineseQuizSection";
import { FlagVoiceModal } from "@/components/FlagVoiceModal";
import { playPointChime, playClick } from "@/lib/sfx";
import { formatSubpartLabel } from "@/lib/subpart-label";
import { isCompOeqLabel } from "@/lib/english-sections";

/* ────────────── types ────────────── */

interface QuizQuestion {
  id: string;
  questionNum: string;
  answer: string | null;
  imageData: string;
  transcribedStem: string | null;
  transcribedOptions: string[] | null;
  transcribedOptionImages: string[] | null;
  // Table-format MCQ — for Science questions where the four
  // options are rows of a comparison table (e.g. "Liquid" vs
  // "Gas"). Mutually exclusive with the two fields above.
  transcribedOptionTable: { columns: string[]; rows: string[][] } | null;
  transcribedSubparts: { label: string; text: string; diagramBase64?: string | null }[] | null;
  diagramImageData: string | null;
  marksAvailable: number | null;
  syllabusTopic: string | null;
  studentAnswer: string | null;
}

interface QuizPaper {
  id: string;
  title: string;
  subject: string | null;
  metadata: {
    quizType: "mcq" | "mcq-oeq";
    sourceLabels?: Record<string, string | null>;
    englishSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }>;
  } | null;
  completedAt: string | null;
  markingStatus: string | null;
  timeSpentSeconds: number;
  questions: QuizQuestion[];
  requesterIsAdmin?: boolean;
  // Assigned student. Settings carries parent-controlled flags like
  // chineseReadingAssist (gates the 🔊 speaker button on Chinese stems).
  assignedTo?: { id: string; name: string | null; settings?: unknown } | null;
}

// `highlight` is a TEXT-only tool — it doesn't draw on a canvas; it
// enables the browser's native text-selection on clean MCQ stems +
// options + tables so a student can mark phrases. ::selection in
// globals.css colours the selection yellow when this tool is active
// (the html element gets data-tool="highlight"). Pen tool tap toggles
// pen ↔ highlight; tap-on-pen-while-pen-is-on flips to highlight,
// tap again flips back, etc.
type DrawTool = "type" | "pen" | "highlight" | "eraser" | "eraser-large";

/* ────────────── helpers ────────────── */

/** MCQ = question has transcribed options (text or images).
 *  An array of 4 entries (even empty) means MCQ — the extraction created option slots. */
function hasQuestionOptions(q: { transcribedOptions?: unknown; transcribedOptionImages?: unknown; transcribedOptionTable?: unknown }): boolean {
  const opts = q.transcribedOptions;
  const imgs = q.transcribedOptionImages;
  const tbl = q.transcribedOptionTable;
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(imgs) && imgs.some((o: unknown) => !!o)) return true;
  if (tbl && typeof tbl === "object" && Array.isArray((tbl as { rows?: unknown }).rows)) return true;
  return false;
}

/** Render __underline__ markup */
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

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

// Strip MCQ answer-key noise so a stored value of "(3) | explanation..."
// compares cleanly against the student's selected option ("3"). Mirrors
// the backend `normalizeMcq` in src/lib/marking.ts — keep these in sync.
function normalizeMcqKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const head = raw.split("|")[0] ?? raw;
  return head.trim().replace(/[().]/g, "").trim();
}

/* ────────────── main page ────────────── */

export default function QuizPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <QuizContent id={id} />
    </Suspense>
  );
}

function QuizContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const isDiagnostic = searchParams.get("diagnostic") === "1";
  const diagnosticParentId = searchParams.get("parentId") ?? "";
  // Build the URL suffix that forwards the diagnostic flag (and parent id) to the review page
  // so the first-quiz popup + 'Open parent homepage' button render there instead of here.
  const diagnosticSuffix = isDiagnostic && diagnosticParentId ? `&diagnostic=1&parentId=${diagnosticParentId}` : "";

  const [paper, setPaper] = useState<QuizPaper | null>(null);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // MCQ answers: questionId -> selected option (1-4)
  const [mcqAnswers, setMcqAnswers] = useState<Record<string, string>>({});
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());

  // OEQ drawing.
  // English and Chinese papers each carry their OWN metadata field
  // (englishSections / chineseSections) so the two pathways stay
  // strictly isolated — no change to Chinese can ripple into English
  // and vice versa.
  const isEnglishQuiz = !!paper?.metadata?.englishSections;
  const isChineseQuiz = !!(paper?.metadata as { chineseSections?: unknown })?.chineseSections;
  const [tool, setTool] = useState<DrawTool>("pen");
  const toolInitRef = useRef(false);
  if ((isEnglishQuiz || isChineseQuiz) && !toolInitRef.current) { toolInitRef.current = true; setTool("type"); }

  // Chinese-only dictionary lookup. Tracks the student's text
  // selection so the toolbar button can fire on the current
  // highlight. Pin the result to a side popover so the student
  // doesn't lose place in the question.
  type DictResult = { word: string; pinyin: string; meaningCn: string; meaningEn: string };
  const [dictSelection, setDictSelection] = useState<string>("");
  const [dictLoading, setDictLoading] = useState(false);
  const [dictResult, setDictResult] = useState<DictResult | null>(null);
  const [dictBlocked, setDictBlocked] = useState<string | null>(null);
  useEffect(() => {
    if (!isChineseQuiz) return;
    const onChange = () => {
      const sel = window.getSelection();
      const text = (sel?.toString() ?? "").trim();
      // Only track Chinese-character selections (1-20 chars). Ignore
      // empty / punctuation-only / overly long picks so the button
      // doesn't enable on accidental highlights of the entire page.
      if (text && text.length <= 20 && /[一-鿿]/.test(text)) setDictSelection(text);
      else setDictSelection("");
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [isChineseQuiz]);

  // Persistent highlighter via CSS Custom Highlight API.
  //
  // Approach:
  //   - Each finished selection in "highlight" mode is cloned to a
  //     persistent Range and pushed into highlightRangesRef.
  //   - CSS.highlights.set("quiz-yellow", new Highlight(...ranges))
  //     paints the Ranges yellow via the ::highlight(quiz-yellow)
  //     pseudo-element (globals.css).
  //   - The DOM is NEVER mutated, so React re-renders (triggered by
  //     tool toggle, prop changes, etc.) don't wipe the highlights.
  //     Ranges stay valid as long as the underlying text nodes do.
  //   - Tap an existing highlight while back in highlight mode to
  //     remove it (no separate eraser button).
  //
  // Browser support: Chrome 105+, Safari 17.4+, Firefox 140+. Older
  // browsers silently get the drag-time ::selection yellow only.
  // The ::highlight(quiz-yellow) CSS rule is injected at runtime
  // (instead of via globals.css) because Tailwind v4 / Lightning CSS
  // strips ::highlight() pseudo-element rules at compile time —
  // bundler doesn't recognise the selector. Inject once on mount.
  useEffect(() => {
    const id = "quiz-highlight-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = "::highlight(quiz-yellow){background-color:#fde68a;color:inherit;}";
    document.head.appendChild(style);
  }, []);

  const highlightRangesRef = useRef<Range[]>([]);
  function applyCssHighlights() {
    const cssAny = CSS as unknown as { highlights?: Map<string, unknown>; Highlight?: unknown };
    const HighlightCtor = (typeof window !== "undefined" ? (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight : undefined);
    if (!cssAny.highlights || !HighlightCtor) return;
    // Drop invalidated ranges (collapsed because their text node was
    // removed) before publishing — Highlight() with a dead Range
    // throws in some engines.
    const live = highlightRangesRef.current.filter(r => !r.collapsed);
    highlightRangesRef.current = live;
    try {
      cssAny.highlights.set("quiz-yellow", new HighlightCtor(...live));
    } catch { /* ignore — highlight set best-effort */ }
  }
  useEffect(() => {
    if (tool !== "highlight") return;
    function persist() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return;
      // Only highlight inside the question card — bail if range spans
      // a button / canvas / input / header.
      let node: Node | null = range.commonAncestorContainer;
      while (node && node.nodeType !== 1) node = node.parentNode;
      let el = node as HTMLElement | null;
      while (el) {
        const tag = el.tagName?.toLowerCase();
        if (tag === "button" || tag === "input" || tag === "canvas" || tag === "header") return;
        el = el.parentElement;
      }
      highlightRangesRef.current.push(range.cloneRange());
      applyCssHighlights();
      sel.removeAllRanges();
    }
    function maybeErase(e: MouseEvent) {
      // Already-existing selection drag? Don't treat as erase.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
      const winAny = window as unknown as { document: Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null } };
      const doc = winAny.document;
      // Find the caret position at the click. Standard API
      // (caretPositionFromPoint, Firefox/spec) and the WebKit-prefixed
      // older one (caretRangeFromPoint).
      let clickNode: Node | null = null;
      let clickOffset = 0;
      if (doc.caretPositionFromPoint) {
        const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
        if (pos) { clickNode = pos.offsetNode; clickOffset = pos.offset; }
      } else if (doc.caretRangeFromPoint) {
        const r = doc.caretRangeFromPoint(e.clientX, e.clientY);
        if (r) { clickNode = r.startContainer; clickOffset = r.startOffset; }
      }
      if (!clickNode) return;
      const idx = highlightRangesRef.current.findIndex(r => {
        try { return r.comparePoint(clickNode!, clickOffset) === 0; }
        catch { return false; }
      });
      if (idx >= 0) {
        highlightRangesRef.current.splice(idx, 1);
        applyCssHighlights();
        e.preventDefault();
      }
    }
    document.addEventListener("mouseup", persist);
    document.addEventListener("touchend", persist);
    document.addEventListener("click", maybeErase);
    return () => {
      document.removeEventListener("mouseup", persist);
      document.removeEventListener("touchend", persist);
      document.removeEventListener("click", maybeErase);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  async function lookupSelection() {
    if (!dictSelection || dictLoading) return;
    // Check if the selection is the TESTED phrase in any visible
    // question (i.e. it's wrapped in **__…__** or __…__ markup in
    // a transcribedStem). If so, don't look it up — would give
    // away the answer for Q13-15-style "pick the correct sentence"
    // questions or for synonym MCQs in section 一.
    const phraseRe = new RegExp(`(\\*\\*__|__)${dictSelection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(__\\*\\*|__)`);
    const isTested = (paper?.questions ?? []).some(q => phraseRe.test(q.transcribedStem ?? ""));
    if (isTested) {
      setDictBlocked(dictSelection);
      setDictResult(null);
      setTimeout(() => setDictBlocked(null), 3500);
      return;
    }
    setDictBlocked(null);
    setDictLoading(true);
    setDictResult(null);
    try {
      const res = await fetch("/api/chinese-dictionary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase: dictSelection }),
      });
      if (res.ok) {
        const data = await res.json();
        setDictResult(data as DictResult);
      } else {
        setDictResult({ word: dictSelection, pinyin: "", meaningCn: "查询失败", meaningEn: "Lookup failed" });
      }
    } catch {
      setDictResult({ word: dictSelection, pinyin: "", meaningCn: "查询失败", meaningEn: "Lookup failed" });
    } finally {
      setDictLoading(false);
    }
  }
  const oeqCanvasHandles = useRef<Record<string, AnswerCanvasHandle | null>>({});
  const oeqSubpartHandles = useRef<Record<string, Record<string, AnswerCanvasHandle | null>>>({});
  const lastDrawnId = useRef<string | null>(null);
  const lastDrawnSubLabel = useRef<Record<string, string | null>>({});
  function undoLastStroke() {
    const qid = lastDrawnId.current;
    if (!qid) return;
    const subLabel = lastDrawnSubLabel.current[qid];
    if (subLabel) {
      const spHandle = oeqSubpartHandles.current[qid]?.[subLabel];
      if (spHandle) { spHandle.undo(); return; }
    }
    oeqCanvasHandles.current[qid]?.undo();
  }
  const canvasHeights = useRef<Record<string, number>>({});

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [emptyFieldIds, setEmptyFieldIds] = useState<Set<string>>(new Set());
  const [mcqScore, setMcqScore] = useState<{ correct: number; total: number; marksEarned: number; marksTotal: number } | null>(null);
  const [displayedMarks, setDisplayedMarks] = useState(0);
  const [scoreJumpKey, setScoreJumpKey] = useState(0);
  const [scorePopups, setScorePopups] = useState<{ id: number; marks: number }[]>([]);
  const [markingOeq, setMarkingOeq] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [savingProgress, setSavingProgress] = useState(false);
  const [progressSaved, setProgressSaved] = useState(false);
  // "Go to homepage" confirmation modal — surfaced when the student
  // (or a parent who clicked through by accident) wants to leave a
  // quiz mid-way. Asks whether to save first.
  const [showHomeConfirm, setShowHomeConfirm] = useState(false);
  const [savingForExit, setSavingForExit] = useState(false);
  // When the home-confirm modal opens, prefetch the student dashboard
  // so the eventual router.push lands almost instantly. Cuts the
  // perceived "stuck" feeling on slow connections — the home page
  // does ~5 API round-trips on first paint, which take 1-3s without
  // prefetch.
  useEffect(() => {
    if (showHomeConfirm && userId) {
      router.prefetch(`/home/${userId}`);
    }
  }, [showHomeConfirm, userId, router]);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  // Tracks which English comp/visual-text sections the student has
  // explicitly entered. Once entered, the section renders side-by-side
  // (passage left, questions right) on lg+. Auto-entered for quizzes
  // whose only section IS comp/visual-text — otherwise the parent /
  // student gets a "Continue to {section}" card first.
  const [enteredCompSections, setEnteredCompSections] = useState<Set<number>>(new Set());
  // The modal asks the user if they want to leave a voice note when
  // FLAGGING a question (not when un-flagging). If the user picks
  // 'No, just flag it' or cancels mid-record, we fall back to the
  // plain POST flag toggle. If they record + end, the upload endpoint
  // raises the flag itself in the same call.
  const [flagVoiceTarget, setFlagVoiceTarget] = useState<string | null>(null);

  // Toggle flag locally AND persist immediately to the DB so the flag survives even if the quiz is never submitted.
  // Scan an ink-only PNG Blob and return the CSS pixel y of the
  // lowest non-transparent pixel + a small padding. Used at submit
  // time to trim canvasHeights to actual ink content rather than how
  // far the student dragged the canvas — so the review page doesn't
  // show a giant blank area below sparse strokes.
  async function inkBottomCss(inkBlob: Blob, fallbackCss: number, maxCanvasCss = 600): Promise<number> {
    try {
      const bitmap = await createImageBitmap(inkBlob);
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext("2d");
      if (!ctx) return fallbackCss;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let bottomInternal = -1;
      for (let y = bitmap.height - 1; y >= 0; y--) {
        let found = false;
        for (let x = 0; x < bitmap.width; x++) {
          if (data[(y * bitmap.width + x) * 4 + 3] > 0) { found = true; break; }
        }
        if (found) { bottomInternal = y; break; }
      }
      if (bottomInternal < 0) return 200; // nothing drawn — small placeholder
      // Internal canvas pixel height ≈ maxCanvasCss × DPR; recover DPR
      // from the bitmap so a different device's submission still maps
      // correctly. Add 20 CSS px padding so the bottom stroke isn't
      // flush against the edge.
      const dpr = bitmap.height / maxCanvasCss;
      const cssBottom = Math.round(bottomInternal / dpr) + 20;
      return Math.min(cssBottom, fallbackCss);
    } catch {
      return fallbackCss;
    }
  }

  function plainToggleFlag(qId: string, nowFlagged: boolean, text?: string) {
    setFlaggedIds(prev => {
      const next = new Set(prev);
      if (nowFlagged) next.add(qId); else next.delete(qId);
      return next;
    });
    fetch(`/api/exam/${id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: qId, userId, text }),
    }).catch(() => {});
  }

  function toggleFlag(qId: string) {
    const isCurrentlyFlagged = flaggedIds.has(qId);
    if (isCurrentlyFlagged) {
      // Un-flagging: skip the popup, just toggle off.
      plainToggleFlag(qId, false);
      return;
    }
    // Flagging on — open the voice-note modal first.
    setFlagVoiceTarget(qId);
  }
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Badge system
  const [badgePopup, setBadgePopup] = useState<{ badge: string; image: string; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/exam/${id}${userId ? `?userId=${userId}` : ""}`);
        if (!res.ok) throw new Error("Not found");
        const data = await res.json();
        setPaper(data);
        setElapsed(data.timeSpentSeconds || 0);
        // Load saved MCQ answers (progress recovery)
        const savedAnswers: Record<string, string> = {};
        for (const q of data.questions ?? []) {
          if (q.studentAnswer) savedAnswers[q.id] = q.studentAnswer;
        }
        if (Object.keys(savedAnswers).length > 0) setMcqAnswers(savedAnswers);
        // Load saved canvas heights
        const savedHeights = (data.metadata as { canvasHeights?: Record<string, number> } | null)?.canvasHeights;
        if (savedHeights) canvasHeights.current = savedHeights;
        if (data.completedAt) {
          setSubmitted(true);
          if (data.markingStatus === "complete" || data.markingStatus === "released") {
            setMarkingDone(true);
          }
        }
      } catch {
        setPaper(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // Timer
  useEffect(() => {
    if (!submitted && paper && !loading) {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [submitted, paper, loading]);

  // MCQ score count-up + "+N" popup animation on submission.
  // Exaggerated: ~700ms between pops, 1.8s each popup, haptic buzz + card shake per pop.
  // Gated on `submitted` (in addition to mcqScore) so the chime
  // doesn't fire during the brief window between scoring and the
  // marking screen mounting — earlier the score was set before
  // submitted flipped to true and the first ding played while the
  // user was still on the loading-spinner screen.
  useEffect(() => {
    if (!submitted || !mcqScore) return;
    if (mcqScore.correct === 0) { setDisplayedMarks(mcqScore.marksEarned); return; }
    const per = mcqScore.correct > 0 ? Math.round(mcqScore.marksEarned / mcqScore.correct) : 0;
    setDisplayedMarks(0);
    let running = 0;
    const timers: number[] = [];
    const STAGGER_MS = 700;
    // Small head-start so the marking-screen pop-in animation has a
    // beat to settle before the first "+N" lands.
    const START_DELAY_MS = 700;
    const POPUP_LIFETIME_MS = 1000;
    for (let i = 0; i < mcqScore.correct; i++) {
      timers.push(window.setTimeout(() => {
        running += per;
        const id = Date.now() + i;
        setScorePopups(prev => [...prev, { id, marks: per }]);
        setDisplayedMarks(Math.min(running, mcqScore.marksEarned));
        // Trigger a small bounce on the score number each time it ticks up.
        setScoreJumpKey(k => k + 1);
        // Slight haptic buzz on mobile — a short double-tap feels more tactile than a single
        // blip, and is still gentle. Silently no-ops on iOS Safari (no Vibration API) and on
        // Android devices with system vibration disabled.
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try { navigator.vibrate([20, 30, 20]); } catch { /* ignore */ }
        }
        // Soft coin chime so each correct MCQ feels rewarding.
        playPointChime(0.25);
        timers.push(window.setTimeout(() => {
          setScorePopups(prev => prev.filter(p => p.id !== id));
        }, POPUP_LIFETIME_MS));
      }, START_DELAY_MS + i * STAGGER_MS));
    }
    // Final settle in case rounding left a gap.
    timers.push(window.setTimeout(
      () => setDisplayedMarks(mcqScore.marksEarned),
      START_DELAY_MS + mcqScore.correct * STAGGER_MS + 400
    ));
    return () => { timers.forEach(t => window.clearTimeout(t)); };
  }, [submitted, mcqScore]);

  // Poll for OEQ marking
  useEffect(() => {
    if (markingOeq && !markingDone) {
      pollRef.current = setInterval(async () => {
        const res = await fetch(`/api/exam/${id}/mark`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.markingStatus === "complete" || data.markingStatus === "released") {
          setMarkingDone(true);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }, 3000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [markingOeq, markingDone, id]);

  function goToReviewWithCelebration() {
    // Confetti for ≥90% now fires on the review page itself (after it loads),
    // so the celebration never lands on top of a marking-in-progress spinner.
    playClick();
    router.push(`/exam/${id}/review?userId=${userId}${diagnosticSuffix}`);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-24 bg-[#f8f9ff] min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-[#dce9ff] border-t-[#001e40]" />
      </div>
    );
  }
  if (!paper) {
    return <div className="p-6 text-center py-24"><p className="text-[#43474f]">Quiz not found</p></div>;
  }

  // Build set of question IDs handled by typed English sections (not OEQ canvasses)
  const typedSectionQIds = new Set<string>();
  // English typed-section detection. Chinese papers go through the
  // separate isChineseQuiz block further down and never touch this
  // branch.
  if (paper.metadata?.englishSections) {
    for (const sec of paper.metadata.englishSections) {
      const label = sec.label.toLowerCase();
      const isTyped = label.includes("grammar cloze") || label.includes("editing") ||
        label.includes("comprehension cloze") || (label.includes("comp") && label.includes("cloze")) ||
        label.includes("visual text") || label.includes("synthesis") ||
        isCompOeqLabel(label);
      if (isTyped) {
        for (let i = sec.startIndex; i <= sec.endIndex; i++) {
          if (paper.questions[i]) typedSectionQIds.add(paper.questions[i].id);
        }
      }
    }
  }

  // Chinese typed-section detection — parallel to the English block
  // above. Kept separate so changes to the Chinese mapping never
  // ripple into the English path.
  const chineseSectionsMeta = (paper.metadata as { chineseSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> })?.chineseSections;
  if (chineseSectionsMeta) {
    for (const sec of chineseSectionsMeta) {
      const label = sec.label.toLowerCase();
      // Chinese 完成对话 = dialogue cloze (typed). 短文填空 + 阅读理解 MCQ
      // + Visual Text MCQ are MCQ. 阅读理解 OEQ is OEQ-typed-answer.
      const isTyped = label.includes("完成对话") || label.includes("对话填空") ||
        label.includes("短文填空") || label.includes("阅读理解") ||
        label.includes("visual text");
      if (isTyped) {
        for (let i = sec.startIndex; i <= sec.endIndex; i++) {
          if (paper.questions[i]) typedSectionQIds.add(paper.questions[i].id);
        }
      }
    }
  }

  const mcqQuestions = paper.questions.filter(q => hasQuestionOptions(q));
  // English / Chinese quizzes: all questions are typed (no canvas OEQ)
  const oeqQuestions = (isEnglishQuiz || isChineseQuiz) ? [] : paper.questions.filter(q => !hasQuestionOptions(q) && !typedSectionQIds.has(q.id));
  const hasOeq = oeqQuestions.length > 0;

  function selectMcqAnswer(questionId: string, option: string) {
    setMcqAnswers(prev => ({ ...prev, [questionId]: option }));
    // Persist to server on every click so a tab close, refresh, or
    // submit-time state loss can't drop the answer. We saw a real
    // case where 5 MCQ landed in the DB with studentAnswer=null
    // even though the student clicked — likely an in-memory state
    // wipe between click and submit. Fire-and-forget; the UI
    // already shows the selection from local state.
    const q = paper?.questions.find(qq => qq.id === questionId);
    if (!q) return;
    const correctLetter = normalizeMcqKey(q.answer);
    const marksAwarded = option === correctLetter ? (q.marksAvailable ?? 1) : 0;
    fetch(`/api/exam/questions/${questionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentAnswer: option, marksAwarded }),
    }).catch(err => console.warn("[quiz] MCQ persist failed:", err));
  }

  async function handleSaveProgress() {
    if (savingProgress) return;
    setSavingProgress(true);
    try {
      // Save all answers (MCQ + typed sections like cloze/editing)
      const questionsWithAnswers = (paper?.questions ?? []).filter(q => mcqAnswers[q.id]);
      await Promise.all(
        questionsWithAnswers.map(q =>
          fetch(`/api/exam/questions/${q.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentAnswer: mcqAnswers[q.id] }),
          })
        )
      );

      // Save OEQ drawings (all questions with canvas handles)
      const saveOeqQs = (paper?.questions ?? []).filter(q => oeqCanvasHandles.current[q.id]);
      if (saveOeqQs.length > 0) {
        const form = new FormData();
        form.append("action", "save");
        for (let i = 0; i < saveOeqQs.length; i++) {
          const q = saveOeqQs[i];
          const handle = oeqCanvasHandles.current[q.id];
          if (handle) {
            const [composite, ink] = await Promise.all([handle.exportImage(), handle.exportInk()]);
            form.append(`page_${i}`, composite, `page_${i}.jpg`);
            form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
            // Trim canvasHeights to actual ink-bottom — student may
            // have dragged the canvas tall but only written near the
            // top. Capped at the visible height so we never claim
            // they wrote further than they could see.
            const visible = canvasHeights.current[q.id] ?? 360;
            const trimmed = await inkBottomCss(ink, visible);
            canvasHeights.current[q.id] = trimmed;
          }
          const spRefs = oeqSubpartHandles.current[q.id];
          if (spRefs) {
            for (const [label, spHandle] of Object.entries(spRefs)) {
              if (spHandle) {
                const [spComposite, spInk] = await Promise.all([spHandle.exportImage(), spHandle.exportInk()]);
                form.append(`page_${i}_${label}`, spComposite, `page_${i}_${label}.jpg`);
                form.append(`page_${i}_${label}_ink`, spInk, `page_${i}_${label}_ink.png`);
                const spKey = `${q.id}_${label}`;
                const spVisible = canvasHeights.current[spKey] ?? 260;
                const spTrimmed = await inkBottomCss(spInk, spVisible);
                canvasHeights.current[spKey] = spTrimmed;
              }
            }
          }
        }
        await fetch(`/api/exam/${id}/submission`, { method: "POST", body: form });
      }

      // Save elapsed time, canvas heights, and OEQ page mapping
      // The page mapping records which question ID maps to which submission page index
      // so the review page doesn't need to recalculate (which can mismatch if code changes)
      const oeqPageMap: Record<string, number> = {};
      saveOeqQs.forEach((q, i) => { oeqPageMap[q.id] = i; });
      const existingMeta = paper?.metadata ?? {};
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeSpentSeconds: elapsed,
          metadata: { ...existingMeta, canvasHeights: canvasHeights.current, oeqPageMap },
        }),
      });

      setProgressSaved(true);
      setTimeout(() => setProgressSaved(false), 2000);
    } catch {
      alert("Failed to save progress");
    } finally {
      setSavingProgress(false);
    }
  }

  // "Go to homepage" — used by the homepage button in the toolbar.
  // Save + leave runs through handleSaveProgress first; discard +
  // leave just routes. Both close the confirmation modal.
  async function goHomeAfterSave() {
    setSavingForExit(true);
    try {
      await handleSaveProgress();
    } finally {
      setShowHomeConfirm(false);
      router.push(`/home/${userId}`);
    }
  }
  function goHomeWithoutSave() {
    setShowHomeConfirm(false);
    router.push(`/home/${userId}`);
  }

  async function handleSubmit() {
    if (submitting) return;

    // Warn if any meaningful share of questions are unanswered.
    // Threshold tightened 0.2 → 0.1 so a 3-blank gap on a 15-Q quiz
    // (Q13–15 case the synthesis student hit) prompts instead of
    // sliding through. Also handles multi-input synthesis: a stem
    // like `___ **keyword** ___` saves as `partA|||partB`, and the
    // old check treated `partA|||` as fully answered because the
    // string was non-empty after trim — split on the separator and
    // count the answer empty if ANY required half is blank.
    const isPartialMultiInput = (raw: string) => {
      if (!raw.includes("|||")) return false;
      const parts = raw.split("|||");
      return parts.some(p => p.trim() === "");
    };
    const allAnswerableQs = paper?.questions ?? [];
    const unansweredCount = allAnswerableQs.filter(q => {
      if (skippedIds.has(q.id)) return false;
      // Non-canvas questions: empty/missing mcqAnswers counts as unanswered
      const hasCanvas = !!oeqCanvasHandles.current[q.id];
      if (hasCanvas) return false; // canvas OEQs: can't cheaply tell if blank, skip the check
      const raw = mcqAnswers[q.id];
      if (!raw || raw.trim() === "") return true;
      if (isPartialMultiInput(raw)) return true;
      return false;
    }).length;
    const answerableTotal = allAnswerableQs.filter(q => !oeqCanvasHandles.current[q.id] && !skippedIds.has(q.id)).length;
    if (answerableTotal > 0 && unansweredCount / answerableTotal > 0.1) {
      const answered = answerableTotal - unansweredCount;
      if (!confirm(`You answered ${answered} of ${answerableTotal} questions (canvas drawings not counted). Submit anyway?`)) return;
    }

    setSubmitting(true);
    try {
      // Score MCQ instantly (exclude skipped)
      let correct = 0;
      let marksEarned = 0;
      let marksTotal = 0;
      const unskippedMcq = mcqQuestions.filter(q => !skippedIds.has(q.id));
      for (const q of unskippedMcq) {
        const selected = mcqAnswers[q.id];
        const correctAns = normalizeMcqKey(q.answer);
        const qMarks = q.marksAvailable ?? 1;
        marksTotal += qMarks;
        if (selected === correctAns) { correct++; marksEarned += qMarks; }
      }
      setMcqScore({ correct, total: unskippedMcq.length, marksEarned, marksTotal });

      // Save MCQ answers to DB via PATCH. Each click already persists
      // to the server (see selectMcqAnswer), so we only PATCH here
      // when the in-memory state actually has the answer — if state
      // got wiped between clicks and submit, we DON'T overwrite the
      // server's already-saved value with null.
      await Promise.all(
        mcqQuestions.map(q => {
          const isSkipped = skippedIds.has(q.id);
          const stateAnswer = mcqAnswers[q.id];
          if (!isSkipped && !stateAnswer) {
            // No state — server already has the per-click value,
            // leave it alone. This is the safety net for the
            // "clicked but lost-state-on-submit" case.
            return Promise.resolve();
          }
          return fetch(`/api/exam/questions/${q.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentAnswer: isSkipped ? "__SKIPPED__" : stateAnswer,
              marksAwarded: isSkipped ? null : (stateAnswer === normalizeMcqKey(q.answer) ? (q.marksAvailable ?? 1) : 0),
            }),
          });
        })
      );

      // Save & score typed section answers
      // Simple comparison: Grammar Cloze, Editing, Comp Cloze
      // AI marking needed: Synthesis, Comp OEQ (just save answer, let markQuizPaper handle)
      const aiMarkSectionLabels = new Set<string>();
      // English AI-marked sections
      if (paper!.metadata?.englishSections) {
        for (const sec of (paper!.metadata.englishSections as Array<{ label: string; startIndex: number; endIndex: number }>)) {
          const l = sec.label.toLowerCase();
          if (l.includes("synthesis") || isCompOeqLabel(l)) {
            for (let i = sec.startIndex; i <= sec.endIndex; i++) {
              if (paper!.questions[i]) aiMarkSectionLabels.add(paper!.questions[i].id);
            }
          }
        }
      }
      // Chinese AI-marked sections — parallel branch, fully isolated
      // from the English block above.
      const chSecs = (paper!.metadata as { chineseSections?: Array<{ label: string; startIndex: number; endIndex: number }> })?.chineseSections;
      if (chSecs) {
        for (const sec of chSecs) {
          if (sec.label.includes("阅读理解 OEQ") || sec.label.includes("阅读理解 oeq")) {
            for (let i = sec.startIndex; i <= sec.endIndex; i++) {
              if (paper!.questions[i]) aiMarkSectionLabels.add(paper!.questions[i].id);
            }
          }
        }
      }
      const simpleCompareQs = paper!.questions.filter(q => typedSectionQIds.has(q.id) && !aiMarkSectionLabels.has(q.id) && !hasQuestionOptions(q));
      const aiMarkQs = paper!.questions.filter(q => aiMarkSectionLabels.has(q.id));

      if (simpleCompareQs.length > 0) {
        await Promise.all(
          simpleCompareQs.map(q => {
            const isGrammarClozeQ = (q.syllabusTopic ?? "").toLowerCase().includes("grammar") && (q.syllabusTopic ?? "").toLowerCase().includes("cloze");
            const stripQuotes = (s: string) => s.replace(/^["'`\s]+|["'`\s]+$/g, "");
            const studentAnsRaw = stripQuotes((mcqAnswers[q.id] ?? "").trim());
            const rawCorrect = stripQuotes(q.answer ?? "");
            let isCorrect = false;
            if (isGrammarClozeQ) {
              // Two formats:
              // 1. Letter keys ("H", "A or B") — student picks letter from word bank
              // 2. Word keys ("helps", "repairs") — student types the word
              const letterMatches = rawCorrect.match(/\b[A-Za-z]\b/g) ?? [];
              const isLetterKey = letterMatches.length > 0 && letterMatches.every(l => l.length === 1)
                && rawCorrect.replace(/[A-Za-z\s/,|.()or]+/gi, "").trim() === "";
              if (isLetterKey) {
                const letters = new Set(letterMatches.map(l => l.toUpperCase()));
                const studentLetter = (studentAnsRaw.toUpperCase().match(/\b[A-Z]\b/) ?? [""])[0];
                isCorrect = !!studentLetter && letters.has(studentLetter);
              } else {
                const acceptableAnswers = rawCorrect.split(/\s+or\s+|\//).map(a => stripQuotes(a.trim()));
                isCorrect = studentAnsRaw !== "" && acceptableAnswers.some(a => a.toLowerCase() === studentAnsRaw.toLowerCase());
              }
            } else {
              // Editing/Comp Cloze — compare raw text case-insensitively
              const acceptableAnswers = rawCorrect.split("/").map(a => stripQuotes(a.trim()));
              isCorrect = studentAnsRaw !== "" && acceptableAnswers.some(a => a.toLowerCase() === studentAnsRaw.toLowerCase());
              // Capitalization check: if matching alt starts with capital, require student to capitalize
              if (isCorrect) {
                const matchingAlt = acceptableAnswers.find(a => a.toLowerCase() === studentAnsRaw.toLowerCase());
                if (matchingAlt && /^[A-Z]/.test(matchingAlt)) {
                  const studentFirst = studentAnsRaw.match(/[A-Za-z]/)?.[0] ?? "";
                  if (studentFirst && studentFirst !== studentFirst.toUpperCase()) {
                    isCorrect = false;
                  }
                }
              }
            }
            return fetch(`/api/exam/questions/${q.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                studentAnswer: studentAnsRaw || null,
                marksAwarded: isCorrect ? (q.marksAvailable ?? 1) : 0,
                markingNotes: studentAnsRaw ? (isCorrect ? "Correct" : `"${studentAnsRaw}" is incorrect. Correct answer: "${rawCorrect}"`) : "No answer",
              }),
            });
          })
        );
      }
      // Save typed answers for AI-marked sections (synthesis, comp OEQ)
      if (aiMarkQs.length > 0) {
        await Promise.all(
          aiMarkQs.map(q => {
            const studentAns = (mcqAnswers[q.id] ?? "").trim();
            return fetch(`/api/exam/questions/${q.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ studentAnswer: studentAns || null }),
            });
          })
        );
      }

      // Persist skip flag for OEQ questions so the marker doesn't try to score them
      const skippedOeqIds = paper!.questions.filter(q => skippedIds.has(q.id) && oeqCanvasHandles.current[q.id]).map(q => q.id);
      if (skippedOeqIds.length > 0) {
        await Promise.all(skippedOeqIds.map(qid =>
          fetch(`/api/exam/questions/${qid}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentAnswer: "__SKIPPED__", marksAwarded: null }),
          })
        ));
      }
      // Save ALL OEQ drawings (skip the ones the student marked as skipped)
      const allOeqWithHandles = paper!.questions.filter(q => oeqCanvasHandles.current[q.id] && !skippedIds.has(q.id));
      if (allOeqWithHandles.length > 0) {
        const form = new FormData();
        form.append("action", "save");
        for (let i = 0; i < allOeqWithHandles.length; i++) {
          const q = allOeqWithHandles[i];
          const handle = oeqCanvasHandles.current[q.id];
          if (handle) {
            const [composite, ink] = await Promise.all([
              handle.exportImage(),
              handle.exportInk(),
            ]);
            // Save combined image
            form.append(`page_${i}`, composite, `page_${i}.jpg`);
            form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
            // Trim canvasHeights to ink content (see saveProgress comment).
            const visible = canvasHeights.current[q.id] ?? 360;
            canvasHeights.current[q.id] = await inkBottomCss(ink, visible);
          }
          // Save individual subpart images.
          //
          // Sanity-check: when q.transcribedSubparts has real labels but
          // oeqSubpartHandles is missing/empty, no per-subpart ink files
          // will be POSTed → the server marker can't tell blank subparts
          // from ink-present ones and can hallucinate (especially on
          // drawable diagrams). Log loudly so production traces flag it.
          const expectedSubLabels = ((q.transcribedSubparts as Array<{ label: string }> | null) ?? [])
            .map(sp => sp.label)
            .filter(l => !l.startsWith("_"));
          const spRefs = oeqSubpartHandles.current[q.id];
          const actualLabels = spRefs ? Object.keys(spRefs).filter(k => !!spRefs[k]) : [];
          if (expectedSubLabels.length > 0 && actualLabels.length < expectedSubLabels.length) {
            const missing = expectedSubLabels.filter(l => !actualLabels.includes(l));
            console.warn(`[submit-subparts] Q${q.questionNum} (${q.id}): expected ${expectedSubLabels.length} subpart handles, got ${actualLabels.length}. Missing: [${missing.join(", ")}]`);
          }
          if (spRefs) {
            for (const [label, spHandle] of Object.entries(spRefs)) {
              if (spHandle) {
                const [spComposite, spInk] = await Promise.all([
                  spHandle.exportImage(),
                  spHandle.exportInk(),
                ]);
                form.append(`page_${i}_${label}`, spComposite, `page_${i}_${label}.jpg`);
                form.append(`page_${i}_${label}_ink`, spInk, `page_${i}_${label}_ink.png`);
                const spKey = `${q.id}_${label}`;
                const spVisible = canvasHeights.current[spKey] ?? 260;
                canvasHeights.current[spKey] = await inkBottomCss(spInk, spVisible);
              }
            }
          }
        }
        await fetch(`/api/exam/${id}/submission`, { method: "POST", body: form });
      }

      // Rewrite oeqPageMap to match what we just uploaded. The autosave
      // version didn't know which OEQs the student would end up skipping,
      // so its indices drift once skips are applied — leaving the review
      // page pointing at stale page numbers (e.g. Q10's image under Q9).
      const submittedPageMap: Record<string, number> = {};
      allOeqWithHandles.forEach((q, i) => { submittedPageMap[q.id] = i; });

      // Save time, final pageMap, and mark as completed.
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeSpentSeconds: elapsed,
          completedAt: new Date().toISOString(),
          metadata: { ...(paper?.metadata ?? {}), canvasHeights: canvasHeights.current, oeqPageMap: submittedPageMap },
        }),
      });

      // Trigger marking (handles both MCQ-only and MCQ+OEQ)
      await fetch(`/api/exam/${id}/mark`, { method: "POST" });
      // Start polling if there are AI-marked questions. English comp cloze runs a
      // per-question AI synonym/grammar check on the server, so include it here too —
      // otherwise the review page renders the client's instant simple-compare marks
      // before the server AI has had a chance to update them.
      const hasAiMarking = hasOeq || ((isEnglishQuiz || isChineseQuiz) && paper!.questions.some(q => {
        const t = (q.syllabusTopic ?? "").toLowerCase();
        return t.includes("synthesis")
          || (t.includes("comprehension") && (t.includes("open") || t.includes("oeq")))
          || (t.includes("comprehension") && t.includes("cloze"));
      }));
      if (hasAiMarking) setMarkingOeq(true);

      // Check for badge milestone
      try {
        const badgeRes = await fetch(`/api/user/${userId}/quiz-badge`);
        if (badgeRes.ok) {
          const badgeData = await badgeRes.json();
          // Only show each badge tier once per user. The server returns newBadge
          // whenever the current count equals a milestone (1/3/10/50/100), which
          // means the Bronze popup would re-fire on every subsequent quiz until the
          // student reaches the Silver threshold. Gate on localStorage.
          if (badgeData.newBadge?.badge) {
            try {
              const key = `mfy-badge-shown-${userId}-${badgeData.newBadge.badge}`;
              if (!localStorage.getItem(key)) {
                setBadgePopup(badgeData.newBadge);
                localStorage.setItem(key, "1");
              }
            } catch {
              setBadgePopup(badgeData.newBadge);
            }
          }
        }
      } catch { /* badge check is non-critical */ }

      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Post-submission view ───
  if (submitted) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-xl max-w-md w-full p-10 text-center">
          <div className="w-20 h-20 rounded-full bg-[#6cf8bb]/30 flex items-center justify-center mx-auto mb-6">
            <span className="material-symbols-outlined text-4xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          </div>
          <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-6">Quiz Complete!</h2>

          {mcqScore && mcqScore.total > 0 && (
            <div className="bg-[#eff4ff] rounded-2xl p-6 mb-4 relative overflow-visible">
              <p className="text-xs font-extrabold uppercase tracking-widest text-[#43474f] mb-2">MCQ Score</p>
              <p className="font-headline text-5xl font-black text-[#001e40]">
                <span
                  key={`jump-${scoreJumpKey}`}
                  className="inline-block"
                  style={{ animation: scoreJumpKey > 0 ? "scoreNumberJump 260ms ease-out" : undefined, transformOrigin: "center" }}
                >
                  {displayedMarks}
                </span>
                <span className="text-2xl font-bold text-[#43474f]"> / {mcqScore.marksTotal} marks</span>
              </p>
              <p className="text-sm font-bold text-[#006c49] mt-2">{mcqScore.marksTotal > 0 ? Math.round((mcqScore.marksEarned / mcqScore.marksTotal) * 100) : 0}% &middot; {mcqScore.correct}/{mcqScore.total} questions</p>
              {/* Floating "+N" popups — one per correct MCQ, staggered */}
              <div className="absolute inset-x-0 -top-8 pointer-events-none">
                {scorePopups.map(p => (
                  <span
                    key={p.id}
                    className="absolute left-1/2 top-0 text-5xl font-black text-[#6cf8bb]"
                    style={{ animation: "plusScorePop 900ms cubic-bezier(0.22,1.15,0.36,1) forwards" }}
                  >
                    +{p.marks}
                  </span>
                ))}
              </div>
            </div>
          )}

          {markingOeq && !markingDone && (
            <>
              <MarkingStatus isEnglish={isEnglishQuiz || isChineseQuiz} />
              <ForceRemarkButton paperId={id} />
            </>
          )}

          {markingOeq && markingDone && (
            <div className="bg-[#6cf8bb]/20 rounded-2xl p-4 mb-4 flex items-center gap-3 animate-[fadeIn_0.4s_ease-out]">
              <span className="material-symbols-outlined text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>task_alt</span>
              <p className="text-sm font-semibold text-[#006c49]">All answers marked!</p>
            </div>
          )}

          <div className="flex gap-3 mt-6">
            {markingOeq && markingDone ? (
              <button
                key="done-button"
                onClick={() => goToReviewWithCelebration()}
                className="flex-1 px-4 py-4 rounded-2xl bg-[#006c49] text-white font-extrabold text-base hover:bg-[#004d35] transition-colors shadow-lg animate-[popIn_0.5s_cubic-bezier(0.34,1.56,0.64,1)]"
              >
                <span className="inline-flex items-center gap-2">
                  <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>celebration</span>
                  Done! Let&apos;s see the results
                </span>
              </button>
            ) : (
              <button
                onClick={() => goToReviewWithCelebration()}
                disabled={markingOeq && !markingDone}
                className="flex-1 px-4 py-3 rounded-2xl bg-[#001e40] text-white font-bold text-sm hover:bg-[#003366] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {markingOeq && !markingDone ? "Marking in progress…" : "Review Answers"}
              </button>
            )}
            <button
              onClick={() => router.push(`/home/${userId}`)}
              className="flex-1 px-4 py-3 rounded-2xl bg-[#eff4ff] text-[#001e40] font-bold text-sm hover:bg-[#dce9ff] transition-colors"
            >
              Home
            </button>
          </div>
        </div>

        {/* Badge milestone popup */}
        {badgePopup && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
            onClick={() => setBadgePopup(null)}>
            <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl text-center"
              onClick={e => e.stopPropagation()}>
              <div className="relative mx-auto w-28 h-28 mb-4">
                <div className="absolute inset-0 animate-ping rounded-full bg-yellow-200 opacity-30" />
                <img src={badgePopup.image} alt={badgePopup.badge} className="relative w-28 h-28 object-contain drop-shadow-lg" />
              </div>
              <h2 className="font-headline text-xl font-extrabold text-[#001e40] mb-2">Congratulations!</h2>
              <p className="text-sm text-[#43474f] leading-relaxed mb-5">{badgePopup.message}</p>
              <button
                onClick={() => setBadgePopup(null)}
                className="px-6 py-2.5 rounded-2xl bg-[#001e40] text-white font-bold hover:bg-[#003366] transition-colors"
              >
                Awesome!
              </button>
            </div>
          </div>
        )}

      </div>
    );
  }

  // ─── Quiz taking view — single scrollable paper ───
  const answeredCount = Object.keys(mcqAnswers).length;

  // Allow text selection when:
  //   - Chinese quiz in "type" mode (dictionary lookup)
  //   - ANY quiz in "highlight" mode (yellow-highlight tool)
  // Drawing tools (pen / eraser) lock selection off so canvas-pointer
  // events don't fight with text-drag-to-select.
  const selectionEnabled = (isChineseQuiz && tool === "type") || tool === "highlight";
  // Some sub-components (Chinese / English quiz sections) accept the
  // legacy 4-state DrawTool. They have no canvas of their own and
  // already treat "type" as "no drawing", so we collapse "highlight"
  // to "type" at the boundary — text-selection styling in highlight
  // mode comes from globals.css ([data-tool="highlight"] ::selection).
  const toolForChild: "type" | "pen" | "eraser" | "eraser-large" =
    tool === "highlight" ? "type" : tool;
  return (
    <div
      data-tool={tool}
      className={`min-h-screen bg-[#f8f9ff] pb-24 ${selectionEnabled ? "" : "select-none"}`}
      style={selectionEnabled
        ? undefined
        : { WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
    >
      {/* ── Mobile Top Bar (split pills) ──
          Single pill used to overflow off-screen on narrow phones —
          the Submit button got half-clipped on the right edge.
          Now: tools pill on the left, action pill on the right,
          gap-2 between. Each pill content fits in its half of
          the viewport. */}
      <header className="lg:hidden fixed top-0 w-full z-50 px-3 py-3 flex justify-between items-center gap-2 bg-[#f8f9ff]/80 backdrop-blur-md">
        <div className="bg-white/90 backdrop-blur-xl rounded-full px-1 py-1 flex items-center gap-0.5 shadow-lg border border-white/30">
          <button
            onClick={() => setShowHomeConfirm(true)}
            title="Back to homepage"
            className="p-2.5 rounded-full text-[#737780] hover:text-[#001e40] hover:bg-[#eff4ff] transition-colors"
          >
            <span className="material-symbols-outlined text-xl">home</span>
          </button>
          <button
            onClick={() => setTool(tool === "pen" ? "highlight" : "pen")}
            className={`p-2.5 rounded-full transition-all ${
              tool === "pen" ? "bg-[#eff4ff] text-[#001e40]"
                : tool === "highlight" ? "bg-yellow-100 text-yellow-700"
                : "text-[#43474f]"
            }`}
            title={tool === "highlight" ? "Highlight text (tap to switch to pen)" : "Draw on diagrams (tap to switch to highlighter)"}
          >
            <span className="material-symbols-outlined text-xl">
              {tool === "highlight" ? "ink_highlighter" : "edit"}
            </span>
          </button>
          {isChineseQuiz && (
            <button
              onClick={() => lookupSelection()}
              disabled={!dictSelection || dictLoading}
              title={dictSelection ? `查 “${dictSelection}”` : "选中要查的词"}
              className={`p-2.5 rounded-full transition-all ${dictSelection ? "text-[#003366] hover:bg-[#eff4ff]" : "text-[#c3c6d1] cursor-not-allowed"}`}
            >
              <span className="material-symbols-outlined text-xl">{dictLoading ? "hourglass_top" : "translate"}</span>
            </button>
          )}
          <button
            onClick={() => setTool(tool === "eraser" ? "eraser-large" : tool === "eraser-large" ? "eraser" : "eraser")}
            className={`p-2.5 rounded-full transition-colors ${tool === "eraser" || tool === "eraser-large" ? "bg-[#eff4ff] text-[#001e40]" : "text-[#737780]"} hover:text-[#001e40]`}
            title="Erase"
          >
            <span className={`material-symbols-outlined ${tool === "eraser-large" ? "text-2xl" : "text-xl"}`}>ink_eraser</span>
          </button>
          <button
            onClick={undoLastStroke}
            className="p-2.5 rounded-full text-[#737780] hover:text-[#001e40] transition-colors"
            title="Undo"
          >
            <span className="material-symbols-outlined text-xl">undo</span>
          </button>
        </div>
        <div className="bg-white/90 backdrop-blur-xl rounded-full px-1 py-1 flex items-center gap-1 shadow-lg border border-white/30">
          <button
            onClick={handleSaveProgress}
            disabled={savingProgress}
            className="flex items-center gap-1 bg-white text-[#003366] border border-[#003366]/20 rounded-full px-3 py-2 font-headline font-bold text-xs hover:bg-[#eff4ff] transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-base">save</span>
            {savingProgress ? "…" : progressSaved ? "✓" : "Save"}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1 bg-[#003366] text-white rounded-full px-3.5 py-2 font-headline font-bold text-xs hover:scale-105 transition-transform disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
            {submitting ? "…" : "Submit"}
          </button>
        </div>
      </header>

      {/* ── Desktop Top App Bar ── */}
      <header className="hidden lg:flex fixed top-0 left-0 w-full z-50 items-center justify-between px-6 py-3 bg-[#f8f9ff] shadow-sm">
        <div className="flex items-center gap-6">
          <h1 className="font-headline text-lg font-bold text-[#001e40]">QuizWorkspace</h1>
          <div className="h-6 w-px bg-[#c3c6d1]/40" />
          <div className="flex items-center gap-4">
            <span className="font-headline text-sm font-semibold text-[#001e40]">{paper.title}</span>
            {mcqQuestions.length > 0 && !isEnglishQuiz && !isChineseQuiz && (
              <span className="px-3 py-1 bg-[#dce9ff] rounded-full font-label text-xs font-bold text-[#001e40]">
                {answeredCount} / {mcqQuestions.length} MCQ
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {/* Back to homepage — opens the save-or-discard confirm modal. */}
          <button
            onClick={() => setShowHomeConfirm(true)}
            title="Back to homepage"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[#737780] hover:text-[#001e40] hover:bg-[#eff4ff] transition-colors font-headline text-[10px] uppercase tracking-wider font-bold border border-[#c3c6d1]/30"
          >
            <span className="material-symbols-outlined text-xl">home</span>
            Home
          </button>
          {/* Drawing tools */}
          <div className="flex items-center bg-[#eff4ff] rounded-lg p-1 border border-[#c3c6d1]/10">
            <button
              onClick={() => setTool(tool === "pen" ? "highlight" : "pen")}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors font-headline text-[10px] uppercase tracking-wider font-bold ${
                tool === "pen" ? "bg-[#003366]/20 text-[#001e40]"
                  : tool === "highlight" ? "bg-yellow-100 text-yellow-700"
                  : "text-[#737780]"
              }`}
              title={tool === "highlight" ? "Highlight text — tap to switch to pen" : "Draw on diagrams — tap to switch to highlighter"}
            >
              <span className="material-symbols-outlined text-xl">
                {tool === "highlight" ? "ink_highlighter" : "edit"}
              </span>
              {tool === "highlight" ? "Highlight" : "Pen"}
            </button>
            {isChineseQuiz && (
              <button
                onClick={() => lookupSelection()}
                disabled={!dictSelection || dictLoading}
                title={dictSelection ? `查 “${dictSelection}”` : "选中要查的词"}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors font-headline text-[10px] uppercase tracking-wider font-bold ${dictSelection ? "text-[#003366] hover:bg-[#dce9ff]" : "text-[#c3c6d1] cursor-not-allowed"}`}
              >
                <span className="material-symbols-outlined text-xl">{dictLoading ? "hourglass_top" : "translate"}</span>
                Dict
              </button>
            )}
            <button
              onClick={() => setTool(tool === "eraser" ? "eraser-large" : tool === "eraser-large" ? "eraser" : "eraser")}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors font-headline text-[10px] uppercase tracking-wider font-bold ${tool === "eraser" || tool === "eraser-large" ? "bg-[#003366]/20 text-[#001e40]" : "text-[#737780]"}`}
            >
              <span className={`material-symbols-outlined ${tool === "eraser-large" ? "text-3xl" : "text-xl"}`}>ink_eraser</span>
              {tool === "eraser-large" ? "Big Erase" : "Erase"}
            </button>
            <button
              onClick={undoLastStroke}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[#737780] hover:bg-[#dce9ff] transition-colors font-headline text-[10px] uppercase tracking-wider font-bold"
            >
              <span className="material-symbols-outlined text-xl">undo</span>
              Undo
            </button>
          </div>
          <div className="h-8 w-px bg-[#c3c6d1]/20 mx-1" />
          {/* Timer hidden for quiz/focused — only the printable
              exam player keeps it. Tracking still runs in the
              background so timeSpentSeconds is recorded. */}
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-[#001e40] text-white px-6 py-2 rounded-lg font-headline font-bold text-sm hover:scale-95 active:scale-90 transition-transform shadow-md disabled:opacity-50"
          >
            {submitting ? "…" : "Submit"}
          </button>
          <button
            onClick={handleSaveProgress}
            disabled={savingProgress}
            className="bg-white text-[#003366] border border-[#003366]/20 px-4 py-2 rounded-lg font-headline font-bold text-sm hover:bg-[#eff4ff] transition-colors disabled:opacity-50"
          >
            {savingProgress ? "Saving…" : progressSaved ? "✓ Saved" : "Save Progress"}
          </button>
        </div>
      </header>

      {/* Single scrollable paper */}
      <div className="pt-24 pb-8 max-w-4xl mx-auto px-4 lg:px-16">

        {/* Mobile progress bar */}
        {mcqQuestions.length > 0 && !isEnglishQuiz && !isChineseQuiz && (
          <div className="lg:hidden mb-8">
            <div className="flex justify-between items-end mb-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#43474f] opacity-70">Progress</span>
                <h2 className="font-headline text-2xl font-extrabold text-[#001e40]">{answeredCount} / {mcqQuestions.length} MCQ</h2>
              </div>
            </div>
            <div className="h-3 w-full bg-[#dce9ff] rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-[#006c49] to-[#4edea3] rounded-full transition-all duration-500"
                style={{ width: `${mcqQuestions.length > 0 ? (answeredCount / mcqQuestions.length) * 100 : 0}%` }} />
            </div>
          </div>
        )}

        {/* Questions — English sections OR Chinese sections OR standard MCQ */}
        {(mcqQuestions.length > 0 || paper.metadata?.englishSections || chineseSectionsMeta) && (
          <>
            {paper.metadata?.englishSections ? (
              // English quiz: render sections by type — UNCHANGED.
              (() => {
                const totalSections = paper.metadata.englishSections.length;
                return (
              <>
                {paper.metadata.englishSections.map((sec, si) => {
                  // Get ALL questions for this section (not just MCQ)
                  const secQuestions = paper.questions.slice(sec.startIndex, sec.endIndex + 1);
                  if (secQuestions.length === 0) return null;

                  const label = sec.label.toLowerCase();
                  const isGrammarCloze = label.includes("grammar cloze");
                  const isEditing = label.includes("editing");
                  const isCompCloze = label.includes("comprehension cloze") || (label.includes("comp") && label.includes("cloze"));
                  const isVisualText = label.includes("visual text");
                  const isSynthesis = label.includes("synthesis");
                  const isCompOeq = isCompOeqLabel(label);
                  const isTypedSection = isGrammarCloze || isEditing || isCompCloze || isVisualText;

                  // Split-screen gating ONLY applies on lg+ (desktop).
                  // Below lg (mobile / iPad portrait) the section
                  // always renders directly with the existing
                  // single-column stacked layout — passage above,
                  // questions below — same as before this feature
                  // was added. The Continue card is purely a desktop
                  // interaction.
                  const wantsSplit = isVisualText || isCompOeq;
                  const isPureCompQuiz = totalSections === 1 && wantsSplit;
                  // Multi-section comp/VT quizzes (e.g. mastery class
                  // Visual Text MCQ pulls 2 passages): auto-enter the
                  // FIRST section so the student lands directly on
                  // the split-screen passage instead of a wall of
                  // grey "Continue to {section}" cards. Subsequent
                  // sections still require an explicit click so the
                  // student paces themselves between passages.
                  const isAutoEnteredFirst = wantsSplit && si === 0;
                  const isEntered = enteredCompSections.has(si) || isPureCompQuiz || isAutoEnteredFirst;
                  // Sibling separator between sections (top border on
                  // anything but the first section). Lives outside the
                  // section content so it doesn't get hidden when the
                  // section is gated behind the Continue card.
                  const divider = si > 0 ? (
                    <hr className="border-t-2 border-slate-200 my-10 lg:my-12" />
                  ) : null;
                  // Continue card: render on lg+ for every unentered
                  // comp section. Mobile never shows the card. Now
                  // that sections render in document order, all
                  // pending Continue buttons are visible at once
                  // rather than gated one-by-one.
                  const continueCard = (wantsSplit && !isEntered) ? (
                    <div className="hidden lg:block mb-12 lg:mb-16">
                      <button
                        type="button"
                        onClick={() => setEnteredCompSections(prev => { const next = new Set(prev); next.add(si); return next; })}
                        className="w-full bg-white rounded-2xl border-2 border-[#dce9ff] hover:border-[#003366] hover:bg-[#f5f9ff] hover:-translate-y-0.5 hover:shadow-md active:scale-[0.99] transition-all p-8 lg:p-12 text-left"
                      >
                        <p className="text-xs font-extrabold text-[#003366] uppercase tracking-wider mb-2">Next section</p>
                        <h2 className="font-headline font-extrabold text-2xl lg:text-3xl text-[#001e40] mb-4 leading-tight">{sec.label}</h2>
                        <p className="text-sm text-[#43474f] leading-relaxed mb-6">
                          On this section, the passage will sit on the left and the questions on the right so you can read and answer without scrolling between them.
                        </p>
                        <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#001e40] text-white text-sm font-bold">
                          Continue to {sec.label}
                          <span className="material-symbols-outlined text-base">arrow_forward</span>
                        </span>
                      </button>
                    </div>
                  ) : null;
                  // The section content itself is hidden on lg+ when
                  // it's a comp section that hasn't been entered yet
                  // (Continue card replaces it). Below lg the section
                  // always shows.
                  const lgHiddenWhenGated = wantsSplit && !isEntered ? "lg:hidden" : "";

                  if (isTypedSection) {
                    return (
                      <Fragment key={si}>
                        {divider}
                        {continueCard}
                        <div className={lgHiddenWhenGated}>
                          <EnglishQuizSection
                            sectionLabel={sec.label}
                            passage={sec.passage ?? null}
                            questions={secQuestions}
                            sectionType={isGrammarCloze ? "grammar-cloze" : isEditing ? "editing" : isCompCloze ? "comprehension-cloze" : "visual-text-mcq"}
                            answers={mcqAnswers}
                            onAnswer={selectMcqAnswer}
                            tool={toolForChild}
                            onToolChange={(t) => setTool(t)}
                            emptyFieldIds={emptyFieldIds}
                            flaggedIds={flaggedIds}
                            onToggleFlag={(qId) => toggleFlag(qId)}
                            splitScreen={wantsSplit && isEntered}
                          />
                        </div>
                      </Fragment>
                    );
                  }

                  // Synthesis / Comp OEQ: typed answer sections
                  if (isSynthesis || isCompOeq) {
                    return (
                      <Fragment key={si}>
                        {divider}
                        {continueCard}
                        <div className={lgHiddenWhenGated}>
                          <EnglishQuizSection
                            sectionLabel={sec.label}
                            passage={sec.passage ?? null}
                            questions={secQuestions}
                            sectionType={isSynthesis ? "synthesis" : "comprehension-oeq"}
                            answers={mcqAnswers}
                            onAnswer={selectMcqAnswer}
                            tool={toolForChild}
                            onToolChange={(t) => setTool(t)}
                            emptyFieldIds={emptyFieldIds}
                            flaggedIds={flaggedIds}
                            onToggleFlag={(qId) => toggleFlag(qId)}
                            splitScreen={wantsSplit && isEntered}
                          />
                        </div>
                      </Fragment>
                    );
                  }

                  // Standard MCQ section (Grammar MCQ, Vocab MCQ, Vocab Cloze MCQ)
                  return (
                    <Fragment key={si}>
                      {divider}
                      <div className="mb-12">
                      <div className="mb-8 mt-4">
                        <h2 className="font-headline text-xl lg:text-2xl font-extrabold text-[#001e40] tracking-tight">{sec.label.toUpperCase()}</h2>
                        <p className="text-[#737780] mt-1 text-sm">Choose the most appropriate answer for each question.</p>
                      </div>

                      {/* Vocab Cloze passage — rich text with formatted blanks */}
                      {sec.passage && !sec.passage.startsWith("[") && !sec.passage.startsWith("data:") && (
                        <div className="bg-[#eff4ff] rounded-2xl p-5 lg:p-8 mb-6 border border-[#d3e4fe]">
                          {sec.passage.split("\n").map((line, li) => {
                            if (!line.trim()) return <br key={li} />;
                            // Skip table separators
                            if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) return null;
                            // Table rows
                            if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
                              const cells = line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
                              return (
                                <div key={li} className="flex gap-2 my-1">
                                  {cells.map((cell, ci) => (
                                    <span key={ci} className="flex-1 text-center text-xs font-medium text-[#001e40] bg-white/60 rounded px-2 py-1">{cell}</span>
                                  ))}
                                </div>
                              );
                            }
                            // Rich text: every **bold** chunk in a Vocab Cloze
                            // MCQ passage is a question marker — either a
                            // blank (the underscore variant) or a highlighted
                            // word the student picks a synonym for. Both render
                            // bold + underlined; the question number prefix
                            // "(N)" is stripped because each question is shown
                            // separately below with its own number. Accepts ALL
                            // historical formats:
                            //   "**________**"           — new numberless blank
                            //   "**(16)________**"        — legacy numbered blank
                            //   "**__plucking__**"        — new numberless word
                            //   "**(17) __plucking__**"   — legacy numbered word
                            //   "**(17) plucking**"       — older numbered word,
                            //                               plain bold, no __ markers
                            //   "**fixated**"             — bare bold word
                            const parts: React.ReactNode[] = [];
                            const regex = /\*\*([^*]+)\*\*/g;
                            let lastIdx2 = 0;
                            let m;
                            let blankCount = 0;
                            while ((m = regex.exec(line)) !== null) {
                              const raw = m[1] ?? "";
                              // Strip leading "(N)" or "(N) " if present.
                              const numMatch = raw.match(/^\s*\((\d+)\)\s*/);
                              const trimmed = (numMatch ? raw.slice(numMatch[0].length) : raw).trim();
                              // Strip optional surrounding __ markers — same
                              // word, just an alternate OCR style.
                              const inner = trimmed.replace(/^__|__$/g, "");
                              const isUnderscoreBlank = /^_{2,}$/.test(inner);
                              // Anything non-empty that isn't a blank counts
                              // as a highlighted word.
                              if (!inner) continue;
                              if (m.index > lastIdx2) parts.push(<span key={`t${lastIdx2}`}>{renderUnderline(line.slice(lastIdx2, m.index))}</span>);
                              const key = numMatch ? numMatch[1] : `p${blankCount++}`;
                              const highlightedWord = !isUnderscoreBlank ? inner : null;
                              // Plain <span> (not inline-flex) so the
                              // word sits flush against surrounding text
                              // without the half-em gap the flex+mx-0.5
                              // wrapper used to insert.
                              parts.push(
                                highlightedWord ? (
                                  <span key={`q${key}`} className="font-bold underline decoration-2 decoration-[#001e40] underline-offset-2 text-[#001e40]">
                                    {highlightedWord}
                                  </span>
                                ) : (
                                  <span key={`q${key}`} className="font-bold underline decoration-2 decoration-[#001e40] underline-offset-2 text-[#001e40] tracking-widest">
                                    ________
                                  </span>
                                )
                              );
                              lastIdx2 = m.index + m[0].length;
                            }
                            if (lastIdx2 < line.length) parts.push(<span key="end">{renderUnderline(line.slice(lastIdx2))}</span>);
                            const indent = line.match(/^(\s{2,}|\t)/);
                            return (
                              <p key={li} className="leading-relaxed text-base text-[#001e40] my-1" style={indent ? { textIndent: "2em" } : undefined}>
                                {parts.length > 0 ? parts : line}
                              </p>
                            );
                          })}
                        </div>
                      )}
                      {sec.passage && label.includes("vocab") && label.includes("cloze") && (
                        <p className="text-sm text-[#737780] mb-6 italic">Which word best completes the blanks?</p>
                      )}

                      <div className="space-y-10">
                        {secQuestions.filter(q => hasQuestionOptions(q)).map((q, idx) => {
                          // For Vocab Cloze MCQ underlined-word variant,
                          // existing data carries the highlighted word
                          // as plain bold ("** plucking**"). Render it
                          // as bold + underlined by wrapping the bold
                          // content in __underscores__ if it's a word
                          // (not a row of underscores from the blank
                          // variant). MathText handles both markers.
                          const isVocabCloze = label.includes("vocab") && label.includes("cloze");
                          const stem = q.transcribedStem ?? null;
                          const transformed = isVocabCloze && stem
                            ? stem.replace(/\*\*\s*([^*_\n][^*\n]*?)\s*\*\*/g, (_full, inner: string) => {
                                // Strip a `(N)` question-number prefix that the
                                // transcribe step embeds inside the bold marker
                                // for mapping purposes — students don't need to
                                // see "(16)" next to the underlined word.
                                let clean = inner.trim().replace(/^\(\d+\)\s*/, "");
                                // Skip purely-underscore content (the blank variant) — leave as bold.
                                if (/^_+$/.test(clean)) return `**${clean}**`;
                                // Already contains __ markers — leave alone.
                                if (clean.includes("__")) return `**${clean}**`;
                                return `**__${clean}__**`;
                              })
                            : stem;
                          const qForRender = transformed !== stem
                            ? { ...q, transcribedStem: transformed }
                            : q;
                          return (
                            <McqQuestionCard
                              key={q.id}
                              question={qForRender}
                              index={sec.startIndex + idx}
                              selected={mcqAnswers[q.id] ?? null}
                              onSelect={(opt) => selectMcqAnswer(q.id, opt)}
                              flagged={flaggedIds.has(q.id)}
                              onToggleFlag={() => toggleFlag(q.id)}
                              tool={tool}
                              hideScratchPad
                            />
                          );
                        })}
                      </div>
                    </div>
                    </Fragment>
                  );
                })}
              </>
                );
              })()
            ) : chineseSectionsMeta ? (
              // Chinese quiz — parallel render block. Forks ChineseQuizSection
              // so any UI iteration on Chinese rendering is fully isolated
              // from the English block above.
              (() => {
                const totalSections = chineseSectionsMeta.length;
                return (
              <>
                {chineseSectionsMeta.map((sec, si) => {
                  const secQuestions = paper.questions.slice(sec.startIndex, sec.endIndex + 1);
                  if (secQuestions.length === 0) return null;
                  const label = sec.label;
                  const labelLc = label.toLowerCase();
                  const isWordBankCloze = label.includes("完成对话") || label.includes("对话填空");
                  const isShortClozeMcq = label.includes("短文填空");
                  // "阅读理解 MCQ", "阅读理解 OEQ", "阅读理解A",
                  // "阅读理解B" (merged 五-A / 五-B). Any 阅读理解
                  // label that ISN'T 短文填空 carries a passage and
                  // wants the split layout. 阅读理解A is mixed MCQ +
                  // OEQ; the ChineseQuizSection renders each question
                  // per-shape (MCQ buttons vs 田字格 canvas).
                  const isAnyComp = label.includes("阅读理解") && !isShortClozeMcq;
                  const isCompAllOeq = (label.includes("阅读理解 OEQ") || labelLc.includes("阅读理解 oeq")) ||
                    (isAnyComp && sec.startIndex !== undefined && (() => {
                      const qs = paper.questions.slice(sec.startIndex, sec.endIndex + 1);
                      return qs.length > 0 && qs.every(q => !Array.isArray(q.transcribedOptions) || q.transcribedOptions.length === 0);
                    })());
                  const isVisualText = labelLc.includes("visual text");
                  // sectionType maps Chinese sections onto the same
                  // renderer shapes the component already supports.
                  const sectionType: "grammar-cloze" | "visual-text-mcq" | "comprehension-oeq" =
                    isWordBankCloze ? "grammar-cloze"
                    : isCompAllOeq ? "comprehension-oeq"
                    : "visual-text-mcq";
                  // Click-to-enter sections: every 阅读理解 (passage
                  // left + questions right) + Visual Text. 短文填空
                  // stays single-column inline pickers. 完成对话 uses
                  // grammar-cloze layout. Mirrors the English
                  // Continue-card pattern but in the Chinese-only
                  // block so changes don't leak.
                  const wantsSplit = isAnyComp || isVisualText;
                  const isPureCompQuiz = totalSections === 1 && wantsSplit;
                  // See the English block above — multi-section comp
                  // quizzes auto-enter the first section so the
                  // student lands directly on the split-screen
                  // passage instead of a wall of Continue cards.
                  const isAutoEnteredFirst = wantsSplit && si === 0;
                  const isEntered = enteredCompSections.has(si) || isPureCompQuiz || isAutoEnteredFirst;
                  const divider = si > 0 ? <hr className="border-t-2 border-slate-200 my-10 lg:my-12" /> : null;
                  // Continue card: render on lg+ for every unentered
                  // wantsSplit section. Mobile never shows the card.
                  const continueCard = (wantsSplit && !isEntered) ? (
                    <div className="hidden lg:block mb-12 lg:mb-16">
                      <button
                        type="button"
                        onClick={() => setEnteredCompSections(prev => { const next = new Set(prev); next.add(si); return next; })}
                        className="w-full bg-white rounded-2xl border-2 border-[#dce9ff] hover:border-[#003366] hover:bg-[#f5f9ff] hover:-translate-y-0.5 hover:shadow-md active:scale-[0.99] transition-all p-8 lg:p-12 text-left"
                      >
                        <p className="text-xs font-extrabold text-[#003366] uppercase tracking-wider mb-2">Next section</p>
                        <h2 className="font-headline font-extrabold text-2xl lg:text-3xl text-[#001e40] mb-4 leading-tight">{sec.label}</h2>
                        <p className="text-sm text-[#43474f] leading-relaxed mb-6">
                          On this section, the passage will sit on the left and the questions on the right so you can read and answer without scrolling between them.
                        </p>
                        <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#001e40] text-white text-sm font-bold">
                          Continue to {sec.label}
                          <span className="material-symbols-outlined text-base">arrow_forward</span>
                        </span>
                      </button>
                    </div>
                  ) : null;
                  // Hide the section body on lg+ while the Continue
                  // card is showing. Mobile always renders the body
                  // directly (single column, no Continue card).
                  const lgHiddenWhenGated = wantsSplit && !isEntered ? "lg:hidden" : "";
                  // Suppress isShortClozeMcq's not-yet-used warning while
                  // making the variable available for downstream
                  // conditional rendering hooks.
                  void isShortClozeMcq;
                  return (
                    <Fragment key={si}>
                      {divider}
                      {continueCard}
                      <div className={`mb-12 ${lgHiddenWhenGated}`}>
                        <ChineseQuizSection
                          sectionLabel={sec.label}
                          passage={sec.passage ?? null}
                          questions={secQuestions}
                          sectionType={sectionType}
                          answers={mcqAnswers}
                          onAnswer={selectMcqAnswer}
                          tool={toolForChild}
                          onToolChange={(t) => setTool(t)}
                          emptyFieldIds={emptyFieldIds}
                          flaggedIds={flaggedIds}
                          onToggleFlag={(qId) => toggleFlag(qId)}
                          splitScreen={wantsSplit && isEntered}
                          readingAssist={
                            (paper?.assignedTo?.settings as { chineseReadingAssist?: boolean } | null | undefined)?.chineseReadingAssist === true
                          }
                        />
                      </div>
                    </Fragment>
                  );
                })}
                <span data-section-total={totalSections} className="hidden" />
              </>
                );
              })()
            ) : (
              // Non-English: standard section
              <>
                <div className="hidden lg:block mb-10 mt-4">
                  <h2 className="font-headline text-2xl lg:text-3xl font-extrabold text-[#001e40] tracking-tight">SECTION A: MULTIPLE CHOICE</h2>
                  <p className="text-[#737780] mt-1 text-sm">Choose the most appropriate answer for each question.</p>
                </div>
                <div className="space-y-10">
                  {mcqQuestions.map((q, idx) => (
                    <McqQuestionCard
                      key={q.id}
                      question={q}
                      index={idx}
                      selected={mcqAnswers[q.id] ?? null}
                      onSelect={(opt) => selectMcqAnswer(q.id, opt)}
                      flagged={flaggedIds.has(q.id)}
                      onToggleFlag={() => toggleFlag(q.id)}
                      skipped={skippedIds.has(q.id)}
                      onSkip={() => setSkippedIds(prev => { const n = new Set(prev); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })}
                      tool={tool}
                    />
              ))}
            </div>
          </>
            )}
          </>
        )}

        {/* Section B: Written / OEQ */}
        {hasOeq && (
          <>
            <div className={`hidden lg:block mb-10 ${mcqQuestions.length > 0 ? "mt-16" : "mt-4"}`}>
              <h2 className="font-headline text-3xl font-extrabold text-[#001e40] tracking-tight">SECTION B: WRITTEN ANSWERS</h2>
              <p className="text-[#737780] mt-1 text-sm">Show all workings clearly. Partial marks may be awarded for correct methodology.</p>
              <p className="text-[#737780] mt-1 text-xs italic">For Apple users: turn on &quot;Draw with Apple Pencil&quot; and turn off &quot;Scribble&quot; for smooth writing.</p>
            </div>
            <p className="lg:hidden text-[#737780] text-xs italic mb-4 px-1">For Apple users: turn on &quot;Draw with Apple Pencil&quot; and turn off &quot;Scribble&quot; for smooth writing.</p>
            <div className="space-y-12">
              {oeqQuestions.map((q, idx) => (
                <OeqQuestionCard
                  key={q.id}
                  question={q}
                  subject={paper?.subject ?? null}
                  index={mcqQuestions.length + idx}
                  tool={tool}
                  onCanvasRef={(handle) => { oeqCanvasHandles.current[q.id] = handle; }}
                  onSubpartRefs={(refs) => { oeqSubpartHandles.current[q.id] = refs; }}
                  onStrokeStart={() => { lastDrawnId.current = q.id; lastDrawnSubLabel.current[q.id] = null; }}
                  onSubpartStrokeStart={(label) => { lastDrawnId.current = q.id; lastDrawnSubLabel.current[q.id] = label; }}
                  paperId={id}
                  oeqIndex={idx}
                  savedHeights={canvasHeights.current}
                  onHeightChange={(cid, h) => { canvasHeights.current[cid] = h; }}
                  flagged={flaggedIds.has(q.id)}
                  onToggleFlag={() => toggleFlag(q.id)}
                  skipped={skippedIds.has(q.id)}
                  onSkip={() => setSkippedIds(prev => { const n = new Set(prev); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Chinese dictionary popover. Fixed right margin so the
          student keeps their place in the question. Auto-dismiss
          when student selects a different phrase or clicks the
          backdrop. Chinese quiz only. */}
      {isChineseQuiz && (dictResult || dictLoading || dictBlocked) && (
        <div className="fixed right-4 top-24 z-50 w-72 bg-white rounded-2xl shadow-xl border border-[#dce9ff] p-4">
          {dictLoading && (
            <div className="flex items-center gap-2 text-sm text-[#43474f]">
              <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
              <span>查询中：{dictSelection}</span>
            </div>
          )}
          {dictBlocked && !dictLoading && (
            <div>
              <p className="text-sm font-bold text-[#001e40] mb-1">{dictBlocked}</p>
              <p className="text-xs text-[#ba1a1a]">这是题目要考的词，无法查询。</p>
              <p className="text-xs text-[#737780] mt-0.5">This phrase is being tested — dictionary disabled.</p>
            </div>
          )}
          {dictResult && !dictLoading && (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="font-bold text-lg text-[#001e40]">{dictResult.word}</p>
                <button onClick={() => setDictResult(null)} className="text-[#737780] hover:text-[#001e40] -mt-1">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              {dictResult.pinyin && <p className="text-sm text-[#003366] italic">{dictResult.pinyin}</p>}
              {dictResult.meaningCn && <p className="text-sm text-[#0b1c30]">{dictResult.meaningCn}</p>}
              {dictResult.meaningEn && <p className="text-xs text-[#737780]">{dictResult.meaningEn}</p>}
            </div>
          )}
        </div>
      )}

      {/* Voice-note popup for flagging questions. Lives at root so it
          renders above all quiz UI. */}
      <FlagVoiceModal
        paperId={id}
        questionId={flagVoiceTarget ?? ""}
        userId={userId}
        open={flagVoiceTarget !== null}
        onClose={() => setFlagVoiceTarget(null)}
        onJustFlag={() => {
          if (flagVoiceTarget) plainToggleFlag(flagVoiceTarget, true);
        }}
        onTextFlagged={(text) => {
          if (flagVoiceTarget) plainToggleFlag(flagVoiceTarget, true, text);
        }}
        onVoiceFlagged={() => {
          if (flagVoiceTarget) {
            setFlaggedIds(prev => new Set(prev).add(flagVoiceTarget));
          }
        }}
      />

      {/* Back-to-homepage confirmation. The Home button in the
          toolbar opens this; the student / parent then chooses
          whether to save first. Backdrop click cancels. */}
      {showHomeConfirm && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
          onClick={() => !savingForExit && setShowHomeConfirm(false)}
        >
          <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-headline font-extrabold text-lg text-[#001e40] mb-1">Going to homepage</h3>
            <p className="text-sm text-[#43474f] mb-5">Save your progress first so you can pick up where you left off?</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={goHomeAfterSave}
                disabled={savingForExit}
                className="w-full py-3 rounded-2xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145] disabled:opacity-60 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-base">save</span>
                {savingForExit ? "Saving…" : "Save & go home"}
              </button>
              <button
                onClick={goHomeWithoutSave}
                disabled={savingForExit}
                className="w-full py-3 rounded-2xl bg-slate-100 text-[#001e40] text-sm font-bold hover:bg-slate-200 disabled:opacity-60"
              >
                Go home without saving
              </button>
              <button
                onClick={() => setShowHomeConfirm(false)}
                disabled={savingForExit}
                className="w-full py-2 text-xs font-bold text-[#43474f] hover:text-[#001e40] disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────── MCQ Question Card ────────────── */

/** Rotating marking-in-progress status messages, subject-aware. */
function MarkingStatus({ isEnglish }: { isEnglish: boolean }) {
  const messages = useMemo(() => {
    const common = [
      "Please wait while our AI is marking…",
      "Pondering over your work…",
      "Thinking carefully…",
    ];
    const english = [
      "Measuring with our grammar ruler…",
      "Checking spelling and tense…",
      "Reading your sentences out loud…",
      "Counting commas and full stops…",
    ];
    const mathSci = [
      "Crunching the numbers…",
      "Checking your working steps…",
      "Cross-checking with the answer key…",
      "Looking for the key concepts…",
    ];
    return [...common, ...(isEnglish ? english : mathSci)];
  }, [isEnglish]);

  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % messages.length), 2500);
    return () => clearInterval(t);
  }, [messages.length]);

  return (
    <div className="bg-gradient-to-r from-[#eff4ff] to-[#dce9ff] rounded-2xl p-5 mb-4 flex items-center gap-4 overflow-hidden">
      <div className="relative shrink-0">
        <div className="animate-spin rounded-full h-8 w-8 border-[3px] border-[#dce9ff] border-t-[#003366]" />
        <span className="absolute inset-0 flex items-center justify-center text-[#003366]">
          <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <p key={idx} className="text-sm font-semibold text-[#001e40] animate-[fadeIn_0.5s_ease-out] truncate">
          {messages[idx]}
        </p>
        <div className="flex gap-1 mt-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#003366]/40 animate-[bounce_1s_ease-in-out_infinite]" />
          <span className="w-1.5 h-1.5 rounded-full bg-[#003366]/40 animate-[bounce_1s_ease-in-out_0.2s_infinite]" />
          <span className="w-1.5 h-1.5 rounded-full bg-[#003366]/40 animate-[bounce_1s_ease-in-out_0.4s_infinite]" />
        </div>
      </div>
    </div>
  );
}

/** "Marking taking too long?" recovery button — fires a re-mark POST while the
 * paper is still in_progress. Shown after a 60s grace period so a normal mark
 * cycle isn't interrupted. */
function ForceRemarkButton({ paperId }: { paperId: string }) {
  const [showAfterGrace, setShowAfterGrace] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowAfterGrace(true), 60_000);
    return () => clearTimeout(t);
  }, []);
  if (!showAfterGrace) return null;
  return (
    <div className="text-center mb-4 -mt-2">
      <button
        type="button"
        disabled={submitting || done}
        onClick={async () => {
          if (!confirm("Marking is taking longer than usual. Force a re-mark now?")) return;
          setSubmitting(true);
          try {
            const res = await fetch(`/api/exam/${paperId}/mark`, { method: "POST" });
            if (res.ok) {
              setDone(true);
              setTimeout(() => setDone(false), 4000);
            } else {
              alert(`Re-mark failed (HTTP ${res.status})`);
            }
          } catch (err) {
            alert(`Re-mark failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setSubmitting(false);
          }
        }}
        className="text-xs font-semibold text-[#43474f] hover:text-[#ba1a1a] underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
      >
        {done ? "✓ Re-mark requested" : submitting ? "Requesting…" : "Marking taking too long? Force re-mark"}
      </button>
    </div>
  );
}

function McqQuestionCard({
  question,
  index,
  selected,
  onSelect,
  hideStem,
  flagged,
  onToggleFlag,
  tool = "pen",
  hideScratchPad,
  skipped,
  onSkip,
}: {
  question: QuizQuestion;
  index: number;
  selected: string | null;
  onSelect: (option: string) => void;
  hideStem?: boolean;
  flagged?: boolean;
  onToggleFlag?: () => void;
  tool?: DrawTool;
  hideScratchPad?: boolean;
  skipped?: boolean;
  onSkip?: () => void;
}) {
  const options = question.transcribedOptions as string[] | null;
  const optionImages = question.transcribedOptionImages as string[] | null;
  const optionTable = question.transcribedOptionTable as { columns: string[]; rows: string[][] } | null;
  const hasImageOptions = optionImages && optionImages.some(img => img);
  const hasOptionTable = !!optionTable && Array.isArray(optionTable.rows) && optionTable.rows.length === 4;

  const numStr = String(index + 1).padStart(2, "0");

  return (
    /* Desktop: relative with big background number; mobile: simple card */
    <article className="relative group">
      {/* Card */}
      <div className="bg-white lg:rounded-xl rounded-3xl shadow-sm lg:shadow-[0_20px_40px_rgba(11,28,48,0.04)] overflow-hidden transition-all hover:shadow-lg relative">
        {/* Mobile: left accent bar */}
        <div className="lg:hidden absolute top-0 left-0 w-1 h-full bg-[#003366]" />

        <div className="p-5 lg:p-8">
          <div className="flex items-center gap-2 mb-3 lg:mb-5">
            <span className="font-headline font-bold text-sm text-[#001e40]">
              Question {numStr}
            </span>
            {onToggleFlag && (
              <button onClick={onToggleFlag} className={`flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-md transition-colors ${flagged ? "text-[#ba1a1a] bg-red-50" : "text-[#737780] hover:text-[#ba1a1a] hover:bg-red-50"}`}>
                <span className="material-symbols-outlined text-sm" style={flagged ? { fontVariationSettings: "'FILL' 1" } : undefined}>flag</span>
              </button>
            )}
            {onSkip && (
              <button onClick={onSkip} className={`flex items-center gap-0.5 text-[10px] font-medium px-2 py-0.5 rounded-md transition-colors ml-auto ${skipped ? "text-[#d58d00] bg-amber-50" : "text-[#c3c6d1] hover:text-[#d58d00] hover:bg-amber-50"}`}>
                <span className="material-symbols-outlined text-sm">block</span>
                {skipped ? "Skipped" : "Skip"}
              </button>
            )}
          </div>

          {skipped ? (
            <div className="py-4 text-center">
              <p className="text-sm text-[#d58d00] font-medium italic">Question skipped — will not be scored</p>
            </div>
          ) : (<>

          {!hideStem && question.transcribedStem && (
            // Wrap the stem in a relative container so the pen-mode
            // ScratchOverlay can sit on top — students working on a
            // tablet often want to circle key words / cross out
            // distractors right on the printed question text. The
            // overlay is pointer-events-none unless tool === pen /
            // eraser, so normal stem reading + scrolling is untouched.
            <div className="relative mb-5 lg:mb-6">
              <p className="font-headline text-lg lg:text-xl font-semibold leading-relaxed text-[#0b1c30] whitespace-pre-wrap">
                <MathText text={question.transcribedStem} />
              </p>
              <ScratchOverlay tool={tool} />
            </div>
          )}

          {/* Fallback: show question image if no stem text */}
          {!hideStem && !question.transcribedStem && question.imageData && question.imageData.length > 100 && (
            <div className="mb-5 lg:mb-6 rounded-xl overflow-hidden border border-[#e5eeff] relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={question.imageData} alt={`Question ${numStr}`} className="w-full h-auto" />
              <ScratchOverlay tool={tool} />
            </div>
          )}

          {question.diagramImageData && (
            <div className="mb-5 lg:mb-6 relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/jpeg;base64,${question.diagramImageData}`}
                alt="Diagram"
                className="w-full rounded-xl border border-[#e5eeff]"
              />
              <ScratchOverlay tool={tool} />
            </div>
          )}

          {/* Options */}
          {hasOptionTable ? (
            // Table-format MCQ. Each row IS one option — student
            // taps the row to select it. Black borders on every
            // cell (collapse model) make the comparison table read
            // like an exam paper's printed table rather than a
            // list of separate buttons. Font size matches the
            // question stem so cells don't look like footnotes.
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-base lg:text-lg border-collapse border-2 border-black">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-3 text-left font-headline font-bold text-black border-2 border-black w-20">Option</th>
                    {optionTable!.columns.map((c, i) => (
                      <th key={i} className="px-4 py-3 text-left font-headline font-bold text-black border-2 border-black">
                        <MathText text={c} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {optionTable!.rows.map((row, ri) => {
                    const optVal = String(ri + 1);
                    const isSelected = selected === optVal;
                    return (
                      <tr
                        key={ri}
                        onClick={() => onSelect(optVal)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(optVal); } }}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? "bg-[#dce9ff]"
                            : "hover:bg-[#eff4ff]"
                        }`}
                      >
                        <td className="px-3 py-3 align-middle border-2 border-black">
                          <div className="flex items-center gap-2">
                            <input
                              type="radio"
                              checked={isSelected}
                              readOnly
                              className="w-5 h-5 accent-[#001e40] pointer-events-none"
                            />
                            <span className="font-headline font-bold text-base text-black">({ri + 1})</span>
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
          ) : hasImageOptions ? (
            <div className="grid grid-cols-2 gap-3 lg:gap-4">
              {[0, 1, 2, 3].map(i => {
                const optVal = String(i + 1);
                const isSelected = selected === optVal;
                const imgSrc = optionImages?.[i];
                return (
                  <button
                    key={i}
                    onClick={() => onSelect(optVal)}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl transition-all ${
                      isSelected
                        ? "bg-[#dce9ff] border-2 border-[#001e40]/20 ring-2 ring-[#001e40]/10"
                        : "bg-[#eff4ff] border-2 border-transparent hover:bg-[#dce9ff]"
                    }`}
                  >
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      isSelected ? "bg-[#001e40] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                    }`}>{i + 1}</span>
                    {imgSrc ? (
                      <img src={`data:image/jpeg;base64,${imgSrc}`} alt={`Option ${i + 1}`} className="w-full rounded" />
                    ) : (
                      <span className="text-sm text-[#737780]">No image</span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            /* Mobile: full-width tap-friendly; Desktop: 2-col grid */
            <div className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-4">
              {[0, 1, 2, 3].map(i => {
                const optVal = String(i + 1);
                const isSelected = selected === optVal;
                const text = options?.[i] ?? `Option ${i + 1}`;
                return (
                  <button
                    key={i}
                    onClick={() => onSelect(optVal)}
                    className={`w-full flex items-center justify-between gap-4 p-4 lg:p-4 rounded-2xl transition-all text-left ${
                      isSelected
                        ? "bg-[#dce9ff] border-2 border-[#001e40]/20 ring-2 ring-[#001e40]/10 scale-[1.02] shadow-sm"
                        : "bg-[#eff4ff] border-2 border-transparent hover:bg-[#dce9ff]"
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <span className={`w-10 h-10 rounded-full flex items-center justify-center font-headline font-bold text-sm shrink-0 ${
                        isSelected ? "bg-[#001e40] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                      }`}>{i + 1}</span>
                      <span className={`font-headline font-semibold text-base ${isSelected ? "text-[#001e40] font-bold" : "text-[#0b1c30]"}`}>
                        <MathText text={text} />
                      </span>
                    </div>
                    {isSelected && (
                      <span className="material-symbols-outlined text-[#006c49] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                    )}
                    {!isSelected && (
                      <div className="w-6 h-6 rounded-full border-2 border-[#c3c6d1] shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {/* Expandable scratch area for workings (math/science only) */}
          {!hideScratchPad && <McqScratchPad tool={tool} />}
          </>)}
        </div>
      </div>
    </article>
  );
}

/** Small pull-out scratch pad for MCQ workings — starts collapsed */
function McqScratchPad({ tool }: { tool: DrawTool }) {
  const [height, setHeight] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const dragStart = useRef<{ y: number; h: number } | null>(null);
  // Undo history — snapshot of the canvas before each new stroke
  const history = useRef<ImageData[]>([]);
  // Watchdog: if a pointerdown sets pointer capture but the matching pointerup
  // never fires (tab switch, zoom gesture interrupting, browser dialog), the
  // canvas stays captured and swallows every subsequent tap — eraser/undo/
  // save/submit all appear dead. Force-release after 10 seconds of silence.
  const captureInfo = useRef<{ target: Element; pointerId: number; timer: number } | null>(null);
  function releaseCapture() {
    const info = captureInfo.current;
    if (!info) return;
    window.clearTimeout(info.timer);
    try { info.target.releasePointerCapture(info.pointerId); } catch { /* already released */ }
    captureInfo.current = null;
  }
  function getPos(e: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  }

  function snapshotForUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || canvas.width === 0) return;
    try {
      history.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (history.current.length > 30) history.current.shift();
    } catch { /* ignore */ }
  }

  function onCanvasDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const t = toolRef.current;
    if (t === "type" || t === "highlight") return;
    snapshotForUndo();
    isDrawing.current = true;
    lastPos.current = getPos(e);
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    // Replace any previous watchdog
    releaseCapture();
    captureInfo.current = {
      target,
      pointerId: e.pointerId,
      timer: window.setTimeout(() => {
        isDrawing.current = false;
        lastPos.current = null;
        releaseCapture();
      }, 10000),
    };
  }
  function onCanvasMove(e: React.PointerEvent) {
    if (!isDrawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !lastPos.current) return;
    const pos = getPos(e);
    const currentTool = toolRef.current;
    const isEraser = currentTool === "eraser" || currentTool === "eraser-large";
    if (isEraser) {
      // destination-out — every pixel the stroke covers becomes transparent.
      // With the parent div bg-white behind the canvas, erasing looks like drawing white.
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = currentTool === "eraser-large" ? 80 : 32;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "#0066cc";
      ctx.lineWidth = 3;
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }
  function onCanvasUp() {
    isDrawing.current = false;
    lastPos.current = null;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx) ctx.globalCompositeOperation = "source-over";
    releaseCapture();
  }

  function handleUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || history.current.length === 0) return;
    const snap = history.current.pop()!;
    ctx.putImageData(snap, 0, 0);
  }

  function onHandleDown(e: React.PointerEvent) {
    e.preventDefault();
    dragStart.current = { y: e.clientY, h: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onHandleMove(e: React.PointerEvent) {
    if (!dragStart.current) return;
    const delta = e.clientY - dragStart.current.y;
    setHeight(Math.max(0, dragStart.current.h + delta));
  }
  function onHandleUp() { dragStart.current = null; }

  // Re-size + preserve content. The previous strokes get redrawn at
  // their NATURAL bitmap size (anchored top-left) — never stretched to
  // fit the new dimensions, otherwise expanding the pad downward
  // would smear existing handwriting vertically.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || height === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.offsetWidth;
    const ctx = canvas.getContext("2d");
    let tempCanvas: HTMLCanvasElement | null = null;
    let prevW = 0;
    let prevH = 0;
    if (ctx && canvas.width > 0 && canvas.height > 0) {
      tempCanvas = document.createElement("canvas");
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      tempCanvas.getContext("2d")!.drawImage(canvas, 0, 0);
      prevW = canvas.width;
      prevH = canvas.height;
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    const newW = w * 2;
    const newH = height * 2;
    canvas.width = newW;
    canvas.height = newH;
    if (ctx && tempCanvas) {
      // Use the smaller of old/new bitmap on each axis so we copy only
      // the overlapping region. Avoids stretching when newH > prevH
      // and avoids cropping when newH < prevH (the bottom of the old
      // content just gets clipped, which is the natural behaviour for
      // shrinking).
      const copyW = Math.min(prevW, newW);
      const copyH = Math.min(prevH, newH);
      ctx.drawImage(tempCanvas, 0, 0, copyW, copyH, 0, 0, copyW, copyH);
    }
    // Clear history on resize (image coordinates change)
    history.current = [];
  }, [height]);

  // Release any stuck pointer capture when the tab is hidden (tab switch, zoom
  // gesture) or the component unmounts — in addition to the 10s watchdog above.
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) {
        isDrawing.current = false;
        lastPos.current = null;
        releaseCapture();
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      releaseCapture();
    };
  }, []);

  return (
    <div className="mt-3">
      {height > 0 && (
        <div className="border border-[#d3e4fe] rounded-t-xl overflow-hidden bg-white relative">
          <canvas
            ref={canvasRef}
            style={{ touchAction: "none", width: "100%", height: `${height}px` }}
            onPointerDown={onCanvasDown}
            onPointerMove={onCanvasMove}
            onPointerUp={onCanvasUp}
            onPointerCancel={onCanvasUp}
            onPointerLeave={onCanvasUp}
            onLostPointerCapture={onCanvasUp}
          />
          <button
            onClick={handleUndo}
            type="button"
            title="Undo last stroke"
            className="absolute top-1 right-1 w-8 h-8 rounded-full bg-white/90 border border-[#d3e4fe] shadow-sm flex items-center justify-center text-[#43474f] hover:text-[#001e40]"
          >
            <span className="material-symbols-outlined text-base">undo</span>
          </button>
        </div>
      )}
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        className={`flex items-center justify-center cursor-ns-resize select-none transition-colors ${height > 0 ? "bg-[#eff4ff] border border-t-0 border-[#d3e4fe] rounded-b-xl" : "bg-[#f8f9ff] border border-[#e5eeff] rounded-xl hover:bg-[#eff4ff]"}`}
        style={{ touchAction: "none", height: "16px" }}
      >
        <div className="w-8 h-1 bg-[#c3c6d1] rounded-full" />
      </div>
    </div>
  );
}

/* ────────────── OEQ Question Card ────────────── */

/* Scratch overlay — transparent drawing layer on question area (not saved) */
function ScratchOverlay({ tool }: { tool: DrawTool }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  // Mirror tool into a ref so pointer handlers always see the current tool
  // (not a stale closure) — pen ↔ eraser switches mid-drawing now take effect.
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // Undo history: snapshot before each stroke so we can roll back.
  const history = useRef<ImageData[]>([]);

  function getPos(e: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  }

  function snapshotForUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || canvas.width === 0) return;
    try {
      history.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (history.current.length > 30) history.current.shift();
    } catch { /* ignore */ }
  }

  function onDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    snapshotForUndo();
    isDrawing.current = true;
    const pos = getPos(e);
    lastPos.current = pos;
    // Draw a dot at the contact point. Without this, a quick tap-to-erase
    // (no drag) produces no onMove events and therefore nothing erases —
    // the bug the user hit on the MCQ diagram scratch layer.
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const currentTool = toolRef.current;
    const isEraser = currentTool === "eraser" || currentTool === "eraser-large";
    if (isEraser) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      // Canvas is 2x display resolution, so radius N canvas-units = N/2
      // display. Bump the tap-erase dot to be clearly visible on MCQ
      // diagram overlays (which are short and dense). Drag-erase
      // lineWidth is in onMove below.
      const r = currentTool === "eraser-large" ? 48 : 20;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#0066cc";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Don't use setPointerCapture — it can get stuck after tab switch/zoom,
    // blocking all button taps until page reload.
  }

  function onMove(e: React.PointerEvent) {
    if (!isDrawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !lastPos.current) return;
    const pos = getPos(e);
    const currentTool = toolRef.current;
    const isEraser = currentTool === "eraser" || currentTool === "eraser-large";
    if (isEraser) {
      // destination-out makes every pixel the stroke covers transparent.
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = currentTool === "eraser-large" ? 96 : 40;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "#0066cc";
      ctx.lineWidth = 2;
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function onUp() {
    isDrawing.current = false;
    lastPos.current = null;
    const ctx = canvasRef.current?.getContext("2d");
    // Reset composite so any subsequent operation (e.g. a resize that
    // re-draws cached content) doesn't unexpectedly erase.
    if (ctx) ctx.globalCompositeOperation = "source-over";
  }

  function handleUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || history.current.length === 0) return;
    const snap = history.current.pop()!;
    ctx.globalCompositeOperation = "source-over";
    ctx.putImageData(snap, 0, 0);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const obs = new ResizeObserver(() => {
      const w = parent.offsetWidth;
      const h = parent.offsetHeight;
      const newW = w * 2;
      const newH = h * 2;
      // Save existing content before resize clears it
      const ctx = canvas.getContext("2d");
      let saved: ImageData | null = null;
      if (ctx && canvas.width > 0 && canvas.height > 0) {
        try { saved = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch { /* empty canvas */ }
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = newW;
      canvas.height = newH;
      // Restore content at NATURAL size — drawing at the new canvas
      // dimensions stretched existing strokes when the canvas grew
      // (e.g. user dragged out the scribble area), making the
      // student's ink elongate. Drawing 1:1 keeps strokes at their
      // original pixel coords; new space below/right is empty.
      if (saved && ctx) {
        const tmp = document.createElement("canvas");
        tmp.width = saved.width; tmp.height = saved.height;
        tmp.getContext("2d")!.putImageData(saved, 0, 0);
        ctx.drawImage(tmp, 0, 0);
      }
    });
    obs.observe(parent);
    return () => obs.disconnect();
  }, []);

  // Highlight is text-only — leave the overlay canvas pointer-events-none
  // so clicks fall through to the page text underneath (where the browser
  // can pick up the user's drag-selection).
  const isActive = tool === "pen" || tool === "eraser" || tool === "eraser-large";
  return (
    <>
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 z-10 ${isActive ? "cursor-crosshair" : "pointer-events-none"}`}
        style={{ touchAction: "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
      />
    </>
  );
}

function OeqQuestionCard({
  question,
  subject,
  index,
  tool,
  onCanvasRef,
  onSubpartRefs,
  onStrokeStart,
  onSubpartStrokeStart,
  paperId,
  oeqIndex,
  savedHeights,
  onHeightChange,
  flagged,
  onToggleFlag,
  skipped,
  onSkip,
}: {
  question: QuizQuestion;
  subject?: string | null;
  index: number;
  tool: DrawTool;
  onCanvasRef: (handle: AnswerCanvasHandle | null) => void;
  onSubpartRefs?: (refs: Record<string, AnswerCanvasHandle | null>) => void;
  onStrokeStart: () => void;
  onSubpartStrokeStart?: (label: string) => void;
  paperId: string;
  oeqIndex: number;
  savedHeights?: Record<string, number>;
  onHeightChange?: (id: string, h: number) => void;
  flagged?: boolean;
  onToggleFlag?: () => void;
  skipped?: boolean;
  onSkip?: () => void;
}) {
  // Math papers want a printed-paper-style "Ans: ___" placeholder
  // in the canvas footer (students are used to it from worksheets).
  // Science answers are usually full sentences / paragraphs, so the
  // overlay just clutters the writing area. Default = show, so any
  // unknown subject (e.g. legacy clones with null subject) keeps
  // current behaviour.
  const isScience = (subject ?? "").toLowerCase().includes("science");
  const showAnsOverlay = !isScience;
  const allSubparts = question.transcribedSubparts as { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null }[] | null;
  // Strip "{questionNum}(a)" / "{questionNum} (a)" prefix from stem + subpart text so we display "(a) ..." consistently.
  const stripQnPrefix = (t: string) => {
    const qn = question.questionNum?.replace(/[^\d]/g, "") ?? "";
    if (!qn) return t;
    return t
      .replace(new RegExp(`\\b${qn}\\s*\\(([a-z])\\)`, "gi"), "($1)")
      .replace(new RegExp(`^\\s*${qn}\\s+`, ""), "");
  };
  // rebuild ref image map from sentinels
  const subRefMap: Record<string, string> = {};
  if (allSubparts) for (const sp of allSubparts) if (sp.label.startsWith("_subref-")) subRefMap[sp.label.slice(8)] = sp.diagramBase64 ?? "";
  const subparts = allSubparts ? allSubparts.filter(sp => !sp.label.startsWith("_")).map(sp => ({ ...sp, refImageBase64: subRefMap[sp.label] ?? sp.refImageBase64 ?? null })) : null;
  const drawableDiagramBase64 = allSubparts?.find(sp => sp.label === "_drawable")?.diagramBase64 ?? null;
  const hasSubparts = subparts && subparts.length > 0;

  // For subparts: one canvas per subpart, stitched on export
  const subCanvasRefs = useRef<Record<string, AnswerCanvasHandle | null>>({});

  // Expose a combined handle that stitches all sub-canvases into one image
  useEffect(() => {
    if (!hasSubparts) return;
    const allLabels = subparts!.map(s => s.label);
    const combinedHandle: AnswerCanvasHandle = {
      async exportImage() {
        const blobs: Blob[] = [];
        for (const label of allLabels) {
          const h = subCanvasRefs.current[label];
          if (h) blobs.push(await h.exportImage());
        }
        return await stitchBlobs(blobs);
      },
      async exportInk() {
        const blobs: Blob[] = [];
        for (const label of allLabels) {
          const h = subCanvasRefs.current[label];
          if (h) blobs.push(await h.exportInk());
        }
        return await stitchBlobs(blobs);
      },
      undo() {
        for (let i = allLabels.length - 1; i >= 0; i--) {
          const h = subCanvasRefs.current[allLabels[i]];
          if (h) { h.undo(); break; }
        }
      },
    };
    onCanvasRef(combinedHandle);
    if (onSubpartRefs) onSubpartRefs(subCanvasRefs.current);
    return () => { onCanvasRef(null); if (onSubpartRefs) onSubpartRefs({}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSubparts]);

  const numStr = String(index + 1).padStart(2, "0");

  return (
    <section className="group">
      <div className="flex flex-col lg:flex-row gap-5 lg:gap-8 items-start">
        {/* Mobile: number + marks + flag in one row */}
        <div className="lg:hidden flex items-center gap-2 mb-1">
          <div className="w-10 h-10 rounded-xl bg-[#001e40] flex items-center justify-center text-white font-headline font-bold text-lg shadow-lg shrink-0">
            {index + 1}
          </div>
          {question.marksAvailable && (
            <span className="bg-[#d3e4fe] text-[#003366] px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-widest whitespace-nowrap">
              [{question.marksAvailable} mark{question.marksAvailable > 1 ? "s" : ""}]
            </span>
          )}
          {onToggleFlag && (
            <button onClick={onToggleFlag} className={`flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-md transition-colors ${flagged ? "text-[#ba1a1a] bg-red-50" : "text-[#737780] hover:text-[#ba1a1a] hover:bg-red-50"}`}>
              <span className="material-symbols-outlined text-sm" style={flagged ? { fontVariationSettings: "'FILL' 1" } : undefined}>flag</span>
            </button>
          )}
          {onSkip && (
            <button onClick={onSkip} className={`flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-md transition-colors ${skipped ? "text-[#d58d00] bg-amber-50" : "text-[#c3c6d1] hover:text-[#d58d00] hover:bg-amber-50"}`}>
              <span className="material-symbols-outlined text-sm">skip_next</span>
              {skipped ? "Skipped" : "Skip"}
            </button>
          )}
        </div>

        {/* Desktop: number badge + flag */}
        <div className="hidden lg:flex flex-none flex-col items-center">
          <div className="w-12 h-12 rounded-xl bg-[#001e40] flex items-center justify-center text-white font-headline font-bold text-xl shadow-lg">
            {index + 1}
          </div>
          {onToggleFlag && (
            <button onClick={onToggleFlag} className={`flex items-center gap-0.5 text-xs font-medium mt-1 px-2 py-0.5 rounded-md transition-colors ${flagged ? "text-[#ba1a1a] bg-red-50" : "text-[#737780] hover:text-[#ba1a1a] hover:bg-red-50"}`}>
              <span className="material-symbols-outlined text-sm" style={flagged ? { fontVariationSettings: "'FILL' 1" } : undefined}>flag</span>
            </button>
          )}
          {onSkip && (
            <button onClick={onSkip} className={`flex items-center gap-0.5 text-[10px] font-medium mt-1 px-2 py-0.5 rounded-md transition-colors ${skipped ? "text-[#d58d00] bg-amber-50" : "text-[#c3c6d1] hover:text-[#d58d00] hover:bg-amber-50"}`}>
              <span className="material-symbols-outlined text-sm">skip_next</span>
              {skipped ? "Skipped" : "Skip"}
            </button>
          )}
        </div>

        {/* Content */}
        <div className={`flex-grow space-y-4 lg:space-y-6 w-full min-w-0 ${skipped ? "opacity-50" : ""}`}>
          {/* Question header — scratch-drawable on desktop only */}
          <div className="relative">
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1 min-w-0">
                {question.transcribedStem && (
                  <p className="font-headline text-lg lg:text-xl font-bold text-[#001e40] leading-relaxed whitespace-pre-wrap">
                    <MathText text={stripQnPrefix(question.transcribedStem)} />
                  </p>
                )}
                {/* When the main stem is empty we deliberately leave it empty. The
                    real content comes from the subparts renderer below (e.g. (a) is
                    the actual question). An empty parent stem on a multi-part row
                    often means the cropped imageData is the whole multi-part region,
                    which would duplicate what subparts show. Don't fall back to it.
                    (Image-only English sections — if ever re-introduced — should be
                    routed through a different renderer, not this OEQ card.) */}
                {/* Show diagram as static reference image — annotatable scratch
                    overlay so students can draw working on diagrams (not submitted). */}
                {question.diagramImageData && (
                  <div className="mt-4 p-5 bg-[#eff4ff] rounded-2xl border-l-4 border-[#006c49]/30 relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:image/jpeg;base64,${question.diagramImageData}`}
                      alt="Diagram"
                      className="w-full rounded-lg"
                    />
                    <ScratchOverlay tool={tool} />
                  </div>
                )}
              </div>
              {/* Desktop marks badge */}
              {question.marksAvailable && (
                <span className="hidden lg:inline-block bg-[#d3e4fe] text-[#003366] px-3 py-1 rounded-md text-xs font-bold uppercase tracking-widest whitespace-nowrap shrink-0">
                  [{question.marksAvailable} mark{question.marksAvailable > 1 ? "s" : ""}]
                </span>
              )}
            </div>
            {/* Scratch overlay — desktop only */}
            <div className="hidden lg:block"><ScratchOverlay tool={tool} /></div>
          </div>

          {/* Sub-parts with individual canvases */}
          {hasSubparts ? (
            <div className="space-y-4">
              {subparts!.map(sp => {
                const marksMatch = sp.text.match(/\[(\d+)\s*(?:m(?:ark)?s?)?\]$/i);
                const spMarks = marksMatch ? parseInt(marksMatch[1]) : null;
                const rawText = marksMatch ? sp.text.slice(0, -marksMatch[0].length).trim() : sp.text;
                // Drop a leading "7(a)" / "(a)" / "a)" / "a." that duplicates the sub-part label we already render.
                // Require at least one delimiter (parens, period, closing bracket) so we don't strip
                // the first letter of words like "Based" when the label is "b".
                const labelRe = new RegExp(`^(\\s*\\d*\\s*(?:\\(${sp.label}\\)|${sp.label}[.)]+)\\s*)`, "i");
                const spText = stripQnPrefix(rawText).replace(labelRe, "");
                return (
                <div key={sp.label} className="bg-white rounded-2xl lg:rounded-3xl overflow-hidden shadow-sm ring-1 ring-[#c3c6d1]/20">
                  <div className="px-5 pt-4 pb-2">
                    {spMarks !== null && (
                      <p className="text-[10px] font-bold text-[#003366] uppercase tracking-widest mb-1">{spMarks} {spMarks === 1 ? "mark" : "marks"}</p>
                    )}
                    <p className="text-base text-[#0b1c30]">
                      <span className="font-bold text-[#001e40]">{formatSubpartLabel(sp.label)}</span> <MathText text={spText} />
                    </p>
                    {sp.refImageBase64 && (
                      <div className="mt-2 relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`data:image/jpeg;base64,${sp.refImageBase64}`}
                          alt={`(${sp.label}) diagram`}
                          className="max-w-full rounded border border-[#e5eeff]"
                        />
                        <ScratchOverlay tool={tool} />
                      </div>
                    )}
                  </div>
                  <ResizableCanvas
                    ref={(h) => { subCanvasRefs.current[sp.label] = h; }}
                    tool={tool}
                    onStrokeStart={() => { onStrokeStart(); onSubpartStrokeStart?.(sp.label); }}
                    defaultHeight={sp.diagramBase64 ? 780 : 260}
                    backgroundImage={sp.diagramBase64 ?? null}
                    savedInkUrl={`/api/exam/${paperId}/submission?page=${oeqIndex}&subpart=${sp.label}&type=ink`}
                    canvasId={`${question.id}_${sp.label}`}
                    savedHeight={savedHeights?.[`${question.id}_${sp.label}`]}
                    onHeightChange={onHeightChange}
                    showAnsOverlay={showAnsOverlay}
                  />
                </div>
              );
              })}
            </div>
          ) : (
            <>
            <ResizableCanvas
              ref={onCanvasRef}
              tool={tool}
              onStrokeStart={onStrokeStart}
              // Drawable canvas adapts to image size: ResizableCanvas
              // pre-measures the background image and sets its visible
              // height to (image display height) + a fixed writing
              // buffer below. defaultHeight is just the seed used
              // until the image loads (or the fallback when no image).
              defaultHeight={drawableDiagramBase64 ? 700 : 300}
              backgroundImage={drawableDiagramBase64}
              savedInkUrl={`/api/exam/${paperId}/submission?page=${oeqIndex}&type=ink`}
              canvasId={question.id}
              savedHeight={savedHeights?.[question.id]}
              onHeightChange={onHeightChange}
              showAnsOverlay={showAnsOverlay}
            />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Stitch multiple image blobs vertically into one */
async function stitchBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) return new Blob([], { type: "image/jpeg" });
  if (blobs.length === 1) return blobs[0];

  const images = await Promise.all(blobs.map(b => {
    return new Promise<HTMLImageElement>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = URL.createObjectURL(b);
    });
  }));

  const width = Math.max(...images.map(i => i.width));
  const totalHeight = images.reduce((sum, i) => sum + i.height, 0);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d")!;
  let y = 0;
  for (const img of images) {
    ctx.drawImage(img, 0, y);
    y += img.height;
    URL.revokeObjectURL(img.src);
  }

  return new Promise<Blob>((resolve) => {
    // Quality 0.99 — bumped from 0.95 (which still showed faint block
    // fringes around 1-2px blue ink lines on drawable diagrams).
    // File size ~2× quality-0.9 but approaches PNG quality; the
    // remaining 1% headroom keeps the encoder from going to true-
    // lossless (which loses chroma subsampling benefits entirely).
    canvas.toBlob(b => resolve(b!), "image/jpeg", 0.99);
  });
}

/* ────────────── Blank Canvas (for writing answers) ────────────── */

const PEN_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Ccircle cx='2' cy='2' r='2' fill='%232563eb'/%3E%3C/svg%3E\") 2 2, crosshair";

interface AnswerCanvasHandle {
  exportImage(): Promise<Blob>;
  exportInk(): Promise<Blob>;
  undo(): void;
}

/* ────────────── Resizable Canvas Wrapper ────────────── */

const ResizableCanvas = forwardRef<
  AnswerCanvasHandle,
  { tool: DrawTool; onStrokeStart: () => void; defaultHeight: number; backgroundImage?: string | null; savedInkUrl?: string | null; canvasId?: string; savedHeight?: number; onHeightChange?: (id: string, h: number) => void; showAnsOverlay?: boolean }
>(function ResizableCanvas({ tool, onStrokeStart, defaultHeight, backgroundImage, savedInkUrl, canvasId, savedHeight, onHeightChange, showAnsOverlay = true }, ref) {
  const maxCanvasHeight = 900;
  const [visibleHeight, setVisibleHeight] = useState(savedHeight ?? defaultHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Adapt the visible canvas height to the drawable image's natural
  // aspect ratio: the image renders at the top of the canvas, scaled
  // to the canvas's 800px-wide pixel grid (capped at 1.5× natural
  // width). Pre-measure the image once, then set canvas display
  // height to "scaled image height (in CSS px) + writing buffer".
  // That way the user's writing room below the diagram is ~constant
  // (≈180px) instead of swinging from 400px on small diagrams to
  // 0px on tall ones. Skipped when the student has a savedHeight
  // (they manually resized — don't fight them).
  useEffect(() => {
    if (!backgroundImage) return;
    if (savedHeight) return;
    const img = new Image();
    img.onload = () => {
      // Pixel-grid scale: same formula BlankCanvas.drawBackground uses.
      const PIXEL_W = 800;
      const PIXEL_H_INTERNAL = maxCanvasHeight * 2; // matches BlankCanvas's CANVAS_H
      const pixelScale = Math.min(PIXEL_W / img.width, PIXEL_H_INTERNAL / img.height, 1.5);
      const pixelImgH = img.height * pixelScale;
      // The canvas is rendered at CSS height = visibleHeight against
      // a pixel-grid height of PIXEL_H_INTERNAL, so the image's CSS
      // height is pixelImgH × (visibleHeight / PIXEL_H_INTERNAL).
      // Solving for visibleHeight such that "image CSS height +
      // writing buffer" === visibleHeight:
      //   v = imgCss + buf  AND  imgCss = pixelImgH × v / PIXEL_H_INTERNAL
      // → v − pixelImgH × v / PIXEL_H_INTERNAL = buf
      // → v = buf / (1 − pixelImgH / PIXEL_H_INTERNAL)
      const WRITING_BUFFER_CSS = 180;
      const ratio = pixelImgH / PIXEL_H_INTERNAL;
      // Defensive: if the image would consume ≥ 90% of the pixel grid
      // there's no room to add a meaningful buffer — just cap at
      // maxCanvasHeight so the image isn't cut off.
      const next = ratio >= 0.9
        ? maxCanvasHeight
        : Math.max(300, Math.min(maxCanvasHeight, Math.round(WRITING_BUFFER_CSS / (1 - ratio))));
      setVisibleHeight(next);
    };
    img.src = backgroundImage;
  }, [backgroundImage, savedHeight, maxCanvasHeight]);

  function onDragStart(e: React.PointerEvent) {
    dragRef.current = { startY: e.clientY, startH: visibleHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDragMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const delta = e.clientY - dragRef.current.startY;
    setVisibleHeight(Math.max(200, Math.min(maxCanvasHeight, dragRef.current.startH + delta)));
  }
  function onDragEnd() {
    dragRef.current = null;
    if (canvasId && onHeightChange) onHeightChange(canvasId, visibleHeight);
  }

  return (
    <div className="relative select-none" style={{ WebkitUserSelect: "none", userSelect: "none", WebkitTouchCallout: "none" }}>
      <div className="bg-white rounded-2xl lg:rounded-3xl overflow-hidden shadow-sm ring-1 ring-[#c3c6d1]/20 relative select-none" style={{ height: visibleHeight, WebkitUserSelect: "none", userSelect: "none", WebkitTouchCallout: "none", touchAction: "none" }}>
        <div className="absolute top-0 left-12 h-full w-px bg-[#ba1a1a]/10" />
        <BlankCanvas
          ref={ref}
          tool={tool}
          onStrokeStart={onStrokeStart}
          height={maxCanvasHeight}
          backgroundImage={backgroundImage}
          savedInkUrl={savedInkUrl}
        />
        {/* Ans: overlay at bottom right — Math only. Science answers
            are sentences/paragraphs so the placeholder just clutters
            the canvas. Caller defaults to true so unknown subjects
            keep the existing behaviour. */}
        {showAnsOverlay && (
          <div className="absolute bottom-3 right-4 pointer-events-none select-none">
            <span className="text-sm font-bold text-slate-300">Ans: ___________</span>
          </div>
        )}
      </div>
      {/* Drag handle */}
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="mx-auto mt-1 w-12 h-3 rounded-full bg-slate-200 hover:bg-slate-300 cursor-ns-resize active:bg-[#003366] transition-colors touch-none"
        style={{ touchAction: "none" }}
      />
    </div>
  );
});

const BlankCanvas = forwardRef<
  AnswerCanvasHandle,
  { tool: DrawTool; onStrokeStart: () => void; height: number; backgroundImage?: string | null; savedInkUrl?: string | null }
>(function BlankCanvas({ tool, onStrokeStart, height, backgroundImage, savedInkUrl }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const pendingSnapshot = useRef<ImageData | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const canvasDims = useRef({ w: 800, h: height * 2 });

  // Fixed canvas resolution — no dynamic resize to avoid zoom breaking buttons

  function drawBackground(ctx: CanvasRenderingContext2D) {
    const cw = canvasDims.current.w;
    const ch = canvasDims.current.h;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    if (bgImageRef.current) {
      // Draw diagram scaled to fit width, preserving aspect ratio.
      // Cap at 1.5× native size — used to be 1.0×, which left small
      // diagrams (e.g. 300×200) tiny in the new bigger canvas. 1.5
      // gives the asked-for "50% bigger" without losing fidelity.
      const img = bgImageRef.current;
      const scale = Math.min(cw / img.width, ch / img.height, 1.5);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (cw - w) / 2;
      const y = 0; // align diagram to top of canvas
      ctx.drawImage(img, x, y, w, h);
    } else {
      // Ruled lines
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1;
      for (let y = 40; y < ch; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cw, y);
        ctx.stroke();
      }
    }
  }

  // Fixed canvas resolution — avoids ResizeObserver clearing ink after zoom
  const CANVAS_W = 800;
  const CANVAS_H = height * 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvasDims.current = { w: CANVAS_W, h: CANVAS_H };
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;

    const inkCanvas = document.createElement("canvas");
    inkCanvas.width = CANVAS_W;
    inkCanvas.height = CANVAS_H;
    inkCanvasRef.current = inkCanvas;

    function init() {
      const ctx = canvas!.getContext("2d", { desynchronized: true })!;
      drawBackground(ctx);

      // Load saved ink if available
      if (savedInkUrl) {
        const inkImg = new Image();
        inkImg.crossOrigin = "anonymous";
        inkImg.onload = () => {
          // Draw ink onto visible canvas
          ctx.drawImage(inkImg, 0, 0, canvasDims.current.w, canvasDims.current.h);
          // Also draw onto ink-only canvas
          const inkCtx = inkCanvasRef.current?.getContext("2d");
          if (inkCtx) inkCtx.drawImage(inkImg, 0, 0, canvasDims.current.w, canvasDims.current.h);
          setReady(true);
        };
        inkImg.onerror = () => setReady(true);
        inkImg.src = savedInkUrl;
      } else {
        setReady(true);
      }
    }

    if (backgroundImage) {
      const img = new Image();
      img.onload = () => { bgImageRef.current = img; init(); };
      // If the image fails to load, still init the canvas so the user can draw
      // (otherwise `ready` never becomes true and pointer listeners never attach,
      //  leaving the canvas silently unresponsive).
      img.onerror = () => { bgImageRef.current = null; init(); };
      img.src = backgroundImage.startsWith("data:") ? backgroundImage : `data:image/jpeg;base64,${backgroundImage}`;
    } else {
      init();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundImage]); // eslint-disable-line react-hooks/exhaustive-deps

  function redrawComposite() {
    const canvas = canvasRef.current;
    const inkCanvas = inkCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { desynchronized: true })!;
    ctx.globalCompositeOperation = "source-over";
    drawBackground(ctx);
    if (inkCanvas) ctx.drawImage(inkCanvas, 0, 0);
  }

  useImperativeHandle(ref, () => ({
    exportImage(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        const canvas = canvasRef.current;
        if (!canvas) { reject(new Error("Not ready")); return; }
        redrawComposite();
        // 0.99 — near-lossless. Earlier bumps (0.88 → 0.95) still left
        // faint block fringing on 1-2px blue ink over white. Pairs
        // with the stitch-path bump in the helper above.
        canvas.toBlob(b => b ? resolve(b) : reject(new Error("Export failed")), "image/jpeg", 0.99);
      });
    },
    exportInk(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        const inkCanvas = inkCanvasRef.current;
        if (!inkCanvas) { reject(new Error("Not ready")); return; }
        inkCanvas.toBlob(b => b ? resolve(b) : reject(new Error("Export failed")), "image/png");
      });
    },
    undo() {
      const inkCanvas = inkCanvasRef.current;
      if (!inkCanvas || history.current.length === 0) return;
      cancelPendingCapture();
      pendingSnapshot.current = null;
      inkCanvas.getContext("2d")!.putImageData(history.current.pop()!, 0, 0);
      redrawComposite();
    },
  }));

  function saveSnapshot() {
    const inkCanvas = inkCanvasRef.current;
    if (!inkCanvas) return;
    history.current.push(inkCanvas.getContext("2d")!.getImageData(0, 0, inkCanvas.width, inkCanvas.height));
    if (history.current.length > 30) history.current.shift();
  }

  function cancelPendingCapture() {
    if (snapshotTimer.current) { clearTimeout(snapshotTimer.current); snapshotTimer.current = null; }
  }

  function scheduleSnapshotCapture() {
    cancelPendingCapture();
    snapshotTimer.current = setTimeout(() => {
      snapshotTimer.current = null;
      const inkCanvas = inkCanvasRef.current;
      if (!inkCanvas) return;
      pendingSnapshot.current = inkCanvas.getContext("2d")!.getImageData(0, 0, inkCanvas.width, inkCanvas.height);
    }, 300);
  }

  const cachedRect = useRef<DOMRect | null>(null);
  function invalidateRect() { cachedRect.current = null; }

  function getPos(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    if (!cachedRect.current) cachedRect.current = canvas.getBoundingClientRect();
    const rect = cachedRect.current;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  useEffect(() => {
    window.addEventListener("scroll", invalidateRect, true);
    window.addEventListener("resize", invalidateRect);
    return () => {
      window.removeEventListener("scroll", invalidateRect, true);
      window.removeEventListener("resize", invalidateRect);
    };
  }, []);

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const onStrokeStartRef = useRef(onStrokeStart);
  onStrokeStartRef.current = onStrokeStart;

  useEffect(() => {
    if (!ready) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { desynchronized: true })!;

    function applyStyleVisible() {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (toolRef.current === "eraser" || toolRef.current === "eraser-large") {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(255,255,255,1)";
        ctx.lineWidth = toolRef.current === "eraser-large" ? 72 : 24;
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(37,99,235,0.85)";
        ctx.lineWidth = 3;
      }
    }

    function applyStyleInk(inkCtx: CanvasRenderingContext2D) {
      inkCtx.lineCap = "round"; inkCtx.lineJoin = "round";
      if (toolRef.current === "eraser" || toolRef.current === "eraser-large") {
        inkCtx.globalCompositeOperation = "destination-out";
        inkCtx.strokeStyle = "rgba(0,0,0,1)";
        inkCtx.lineWidth = toolRef.current === "eraser-large" ? 72 : 24;
      } else {
        inkCtx.globalCompositeOperation = "source-over";
        inkCtx.strokeStyle = "rgba(37,99,235,0.85)";
        inkCtx.lineWidth = 3;
      }
    }

    // Track previous midpoint for quadratic-curve smoothing. Between three
    // consecutive samples a, b, c we draw quadraticCurveTo(b, mid(b,c))
    // starting from mid(a,b). That turns the per-segment 60 Hz straight
    // facets into smooth curves, which is what finger input needs —
    // browsers sample finger input sparsely so raw lineTo looks jagged.
    const lastMid = { x: 0, y: 0 };

    function handlePointerDown(e: PointerEvent) {
      if (toolRef.current === "type" || toolRef.current === "highlight") return;
      e.preventDefault();
      // Route subsequent move/up events here even if the finger slides off
      // the canvas, so strokes don't end prematurely at the edge.
      canvas!.setPointerCapture(e.pointerId);
      cancelPendingCapture();
      onStrokeStartRef.current();
      isDrawing.current = true;
      if (pendingSnapshot.current) {
        history.current.push(pendingSnapshot.current);
        if (history.current.length > 30) history.current.shift();
        pendingSnapshot.current = null;
      } else if (history.current.length === 0) {
        saveSnapshot();
      }
      const pos = getPos(e.clientX, e.clientY);
      lastPos.current = pos;
      lastMid.x = pos.x; lastMid.y = pos.y;
      applyStyleVisible();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, toolRef.current === "eraser-large" ? 36 : (toolRef.current === "eraser" ? 12 : 1.5), 0, Math.PI * 2);
      ctx.fill();
      const inkCtx = inkCanvasRef.current?.getContext("2d");
      if (inkCtx) {
        applyStyleInk(inkCtx);
        inkCtx.beginPath();
        inkCtx.arc(pos.x, pos.y, toolRef.current === "eraser-large" ? 36 : (toolRef.current === "eraser" ? 12 : 1.5), 0, Math.PI * 2);
        inkCtx.fill();
      }
      if (toolRef.current === "eraser" || toolRef.current === "eraser-large") redrawComposite();
    }

    function drawSegment(prev: { x: number; y: number }, cur: { x: number; y: number }, inkCtx: CanvasRenderingContext2D | null | undefined, useEraser: boolean) {
      const mid = { x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2 };
      applyStyleVisible();
      ctx.beginPath();
      if (useEraser) {
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(cur.x, cur.y);
      } else {
        ctx.moveTo(lastMid.x, lastMid.y);
        ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
      }
      ctx.stroke();
      if (inkCtx) {
        applyStyleInk(inkCtx);
        inkCtx.beginPath();
        if (useEraser) {
          inkCtx.moveTo(prev.x, prev.y);
          inkCtx.lineTo(cur.x, cur.y);
        } else {
          inkCtx.moveTo(lastMid.x, lastMid.y);
          inkCtx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
        }
        inkCtx.stroke();
      }
      lastMid.x = mid.x; lastMid.y = mid.y;
    }

    function handlePointerMove(e: PointerEvent) {
      if (!isDrawing.current || !lastPos.current) return;
      e.preventDefault();
      // getCoalescedEvents returns every pointer sample the OS buffered
      // since the previous pointermove — on a 120 Hz Apple Pencil or a
      // high-poll-rate trackpad we're otherwise throwing away intermediate
      // samples, which produces visible kinks in fast strokes.
      const samples = typeof e.getCoalescedEvents === "function"
        ? e.getCoalescedEvents()
        : [e];
      const useEraser = toolRef.current === "eraser" || toolRef.current === "eraser-large";
      const inkCtx = inkCanvasRef.current?.getContext("2d");
      for (const s of samples) {
        const pos = getPos(s.clientX, s.clientY);
        drawSegment(lastPos.current, pos, inkCtx, useEraser);
        lastPos.current = pos;
      }
    }

    function handlePointerUp() {
      if (!isDrawing.current) return;
      isDrawing.current = false;
      lastPos.current = null;
      // Reset smoothing midpoint so the next stroke's first segment
      // doesn't pick up the previous stroke's midpoint. Matches the
      // Chinese onUp handler.
      lastMid.x = 0;
      lastMid.y = 0;
      if (toolRef.current === "eraser" || toolRef.current === "eraser-large") redrawComposite();
      scheduleSnapshotCapture();
    }

    function handleContextMenu(e: Event) { e.preventDefault(); }

    // pointerrawupdate fires for raw input samples even between vsyncs
    // on Chrome / Edge / Android Chrome — Safari ignores it. We attach
    // it in addition to pointermove; either one calling handlePointerMove
    // is fine because lastPos.current keeps the chain continuous, and
    // any duplicate sample produces a zero-length segment that's
    // invisible. Without this, fast strokes drop samples between
    // vsyncs and produce intermittent gaps in the line — the same
    // bug the Chinese canvas fixed in commit d47c433f.
    function handlePointerRaw(e: PointerEvent) {
      if (!isDrawing.current || !lastPos.current) return;
      handlePointerMove(e);
    }

    // Defensive: pointercancel was treated as an end-of-stroke signal.
    // iPadOS recently started firing spurious pointercancel mid-stroke
    // for Apple Pencil ("stylus gaps started 1-2 days ago for both
    // Math/Science and Chinese, finger still works"). The cancel reset
    // isDrawing/lastPos so subsequent pointermove samples were dropped
    // → visible gap, then drawing resumes when the user lifts and
    // touches again. Treat pointercancel as a no-op: re-acquire
    // pointer capture if possible and keep lastPos so the next
    // pointermove continues the stroke. Real cancels (3-finger swipe
    // etc.) end naturally on the next pointerdown.
    function handlePointerCancel(e: PointerEvent) {
      if (!isDrawing.current) return;
      try { canvas!.setPointerCapture(e.pointerId); } catch { /* capture lost */ }
    }

    canvas.addEventListener("pointerdown", handlePointerDown, { passive: false });
    canvas.addEventListener("pointermove", handlePointerMove, { passive: false });
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerCancel);
    canvas.addEventListener("contextmenu", handleContextMenu);
    // The "as keyof HTMLElementEventMap" cast is needed because
    // pointerrawupdate isn't yet in lib.dom.d.ts in all TS versions.
    canvas.addEventListener(
      "pointerrawupdate" as keyof HTMLElementEventMap,
      handlePointerRaw as EventListener,
      { passive: false } as AddEventListenerOptions,
    );
    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerCancel);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      canvas.removeEventListener(
        "pointerrawupdate" as keyof HTMLElementEventMap,
        handlePointerRaw as EventListener,
      );
      cancelPendingCapture();
    };
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Wrapper + canvas styles mirror ChineseHandwritingCanvas exactly.
    // iOS Safari fires pointercancel mid-stroke if ANY ancestor leaves
    // the selection / callout machinery armed — locking the wrapper as
    // well as the canvas closes that hole.
    <div
      className="select-none"
      style={{
        touchAction: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
        WebkitTouchCallout: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        // Pointer handlers attach natively in useEffect (passive: false,
        // plus pointerrawupdate on Chrome/Edge for sub-vsync samples).
        // willChange + translateZ promote the canvas to its own GPU
        // layer so per-stroke repaints don't invalidate surrounding
        // content and trigger iOS render throttling.
        className="w-full border-0 block touch-none select-none"
        style={{
          height: `${height}px`,
          cursor: tool === "pen" ? PEN_CURSOR : "cell",
          touchAction: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
          WebkitTouchCallout: "none",
          willChange: "contents",
          transform: "translateZ(0)",
        }}
      />
    </div>
  );
});
