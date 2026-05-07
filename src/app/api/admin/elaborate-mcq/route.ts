import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { mathHeuristicsBlock } from "@/lib/math-heuristics";

// Allow up to 5min on Vercel Pro — sequential Gemini calls run
// ~5-10s each, so a batch of 3 still fits in 60s comfortably while
// a batch of 10 risks the default function timeout.
export const maxDuration = 300;

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _ai;
}

// Sentinel written to elaboration when a generation fails. Lets us
// (a) exclude the row from future bulk batches via a starts-with
// filter so the loop doesn't keep retrying the same broken rows
// across page reloads, and (b) have the per-card elaborate route
// recognise it and re-attempt on demand. Format is JSON so it
// parses cleanly; the per-card route's parseCachedElaboration will
// treat it as a cache miss because there's no `solution` field.
const ELAB_ERROR_PREFIX = '{"__elabError"';
function makeErrorSentinel(message: string): string {
  return JSON.stringify({ __elabError: message.slice(0, 280), attemptedAt: new Date().toISOString() });
}

// Prompt mirrors the per-question /api/exam/[id]/elaborate prompt
// (clean-text path) so the bulk job produces the same shape of
// explanation. Master MCQ have transcribedStem + transcribedOptions
// (clean extract) so we never fall back to raw image OCR here.
const COMMON_DIAGRAM_RULES = `When a fraction-of-fraction word problem, ratio problem, before-vs-after comparison, or any question where a visual breakdown would help, also return a "diagrams" array using the Singapore model method:
[{
  "title": "<e.g. 'Step 1: Initial ratio' or null for single-step>",
  "rows": [{ "label": "<name or quantity>", "units": <integer 1-12>, "value": "<known value, '?' if unknown, or null>" }],
  "unitValue": "<value of 1 unit if determinable, else null>"
}]
Rules:
- Use multi-step ONLY if the problem changes state (e.g. 'After …'). Most questions need exactly one diagram.
- Each row = one labelled bar. units = the integer count (e.g. ratio 3:5 → units 3 and 5).
- value = the actual quantity if known/solved, "?" if asked for, null if not relevant.
- Optionally add a Total row.
- Maximum 5 rows per step. units must be 1–12.
- Only emit a diagram when it actually adds clarity. For straightforward arithmetic, return "diagrams": [].

Respond with ONLY valid JSON (no markdown fences, no surrounding text):
{
  "solution": "<step-by-step text with **bold** as described above>",
  "diagrams": [...]
}`;

type DiagramRow = { label: string; units: number; value: string | null };
type DiagramStep = { title: string | null; rows: DiagramRow[]; unitValue: string | null };

function parseModelResponse(text: string): { solution: string; diagrams: DiagramStep[] } {
  let raw = text.trim();
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1].trim();
  try {
    const parsed = JSON.parse(raw) as { solution?: unknown; diagrams?: unknown };
    if (parsed && typeof parsed.solution === "string") {
      const diagrams = Array.isArray(parsed.diagrams) ? (parsed.diagrams as DiagramStep[]) : [];
      return { solution: parsed.solution, diagrams };
    }
  } catch { /* not JSON — treat the whole thing as plain solution text */ }
  return { solution: text, diagrams: [] };
}

// Scope: P3-P6 Math + Science MCQ on real master papers
// (paperType=null, sourceExamId=null), no elaboration yet.
//
// MCQ detection has to happen in JS because Prisma's JSON-array-length
// filters are brittle — we pull a slightly wider candidate pool and
// keep MCQ. Result: bulk run touches the same questions the per-card
// elaborate path would, just without a student in the loop.
const MASTER_SCOPE: Prisma.ExamPaperWhereInput = {
  sourceExamId: null,
  paperType: null,
  OR: [
    { subject: { contains: "math", mode: "insensitive" } },
    { subject: { contains: "science", mode: "insensitive" } },
  ],
  AND: [{
    OR: [
      { level: { contains: "Primary 3", mode: "insensitive" } },
      { level: { contains: "Primary 4", mode: "insensitive" } },
      { level: { contains: "Primary 5", mode: "insensitive" } },
      { level: { contains: "Primary 6", mode: "insensitive" } },
      { level: { equals: "P3", mode: "insensitive" } },
      { level: { equals: "P4", mode: "insensitive" } },
      { level: { equals: "P5", mode: "insensitive" } },
      { level: { equals: "P6", mode: "insensitive" } },
    ],
  }],
};

function isMcqRow(opts: unknown, optImgs: unknown, answer: string | null): boolean {
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(optImgs) && optImgs.some((o) => !!o)) return true;
  const a = (answer ?? "").trim().replace(/[().]/g, "");
  return a === "1" || a === "2" || a === "3" || a === "4";
}

// GET — counts: total MCQ in scope, real elaborations vs error
// sentinels vs never-tried, per-level + per-subject breakdown.
// Failed rows are reported separately so the admin sees the
// breakdown rather than thinking the loop is stuck.
export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const qs = await prisma.examQuestion.findMany({
    where: { examPaper: MASTER_SCOPE },
    select: {
      transcribedOptions: true, transcribedOptionImages: true, answer: true, elaboration: true,
      examPaper: { select: { subject: true, level: true } },
    },
  });
  let total = 0, elaborated = 0, failed = 0;
  type Bucket = { total: number; elaborated: number; failed: number };
  const byLevel: Record<string, Bucket> = {};
  const bySubject: Record<string, Bucket> = {};
  function bump(map: Record<string, Bucket>, key: string, kind: "elab" | "fail" | "none") {
    if (!map[key]) map[key] = { total: 0, elaborated: 0, failed: 0 };
    map[key].total++;
    if (kind === "elab") map[key].elaborated++;
    else if (kind === "fail") map[key].failed++;
  }
  for (const q of qs) {
    if (!isMcqRow(q.transcribedOptions, q.transcribedOptionImages, q.answer)) continue;
    total++;
    const isFail = !!q.elaboration && q.elaboration.startsWith(ELAB_ERROR_PREFIX);
    const isElab = !!q.elaboration && !isFail;
    if (isElab) elaborated++;
    if (isFail) failed++;
    const lvl = (q.examPaper.level ?? "?").replace(/Primary /i, "P");
    const subj = (q.examPaper.subject ?? "?").trim();
    bump(byLevel, lvl, isElab ? "elab" : isFail ? "fail" : "none");
    bump(bySubject, subj, isElab ? "elab" : isFail ? "fail" : "none");
  }
  return NextResponse.json({
    total,
    elaborated,
    failed,
    pending: total - elaborated - failed,
    byLevel,
    bySubject,
  });
}

// POST — process the next `limit` MCQs. Sequential calls so a
// failing question doesn't kill its neighbours; concurrency=2
// would only save seconds and risks Gemini rate limits.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  // Default to 3 — sequential Gemini elaborate calls take ~5-10s
  // each, so a batch of 3 fits in 60s comfortably while a batch
  // of 10 risks the Vercel function timeout.
  const limit = Math.max(1, Math.min(20, Number(body.limit ?? 3)));
  const excludeIds: string[] = Array.isArray(body.excludeIds)
    ? (body.excludeIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  // Two-phase query so we don't over-fetch:
  //
  // Phase A — slim scan over EVERY pending row in scope to find the
  // next `limit` MCQ ids. Only the MCQ-detection fields plus id, no
  // diagramImageData (which can be large). The pool used to be a
  // capped `take: limit*4` ordered by id, but in practice the first
  // 40 pending rows are mostly OEQ — the MCQ are scattered later in
  // the master ordering — so MCQ filter came out empty and the batch
  // returned `processed: 0` despite 1300+ pending. Removing the cap
  // means we scan everything but the row size is tiny.
  //
  // Phase B — full-content fetch for just those MCQ ids, with the
  // diagramImageData and other fields the prompt needs.
  const slim = await prisma.examQuestion.findMany({
    where: {
      elaboration: null,
      examPaper: MASTER_SCOPE,
      ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    },
    select: { id: true, transcribedOptions: true, transcribedOptionImages: true, answer: true },
    orderBy: { id: "asc" },
  });
  const mcqIds = slim
    .filter((q) => isMcqRow(q.transcribedOptions, q.transcribedOptionImages, q.answer))
    .slice(0, limit)
    .map((q) => q.id);
  const mcq = mcqIds.length === 0 ? [] : await prisma.examQuestion.findMany({
    where: { id: { in: mcqIds } },
    select: {
      id: true, questionNum: true, examPaperId: true,
      transcribedStem: true, transcribedOptions: true, transcribedOptionImages: true,
      transcribedSubparts: true, diagramImageData: true, answer: true,
      syllabusTopic: true,
      examPaper: { select: { title: true, subject: true, level: true } },
    },
  });

  type ResultRow = { id: string; questionNum: string; paperId: string; paperTitle: string; subject: string; level: string; ok: boolean; error?: string };
  const results: ResultRow[] = [];

  for (const q of mcq) {
    const opts = q.transcribedOptions as string[] | null;
    const subs = q.transcribedSubparts as { label: string; text: string }[] | null;
    let questionText = q.transcribedStem ?? `Question ${q.questionNum}`;
    if (opts && opts.length > 0) {
      questionText += "\n" + opts.map((o, i) => `(${i + 1}) ${o}`).join("\n");
    }
    if (subs && subs.length > 0) {
      questionText += "\n" + subs.filter((s) => s.label !== "_drawable").map((s) => `(${s.label}) ${s.text}`).join("\n");
    }

    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
    if (q.diagramImageData) {
      const match = q.diagramImageData.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    const hasDiagram = !!q.diagramImageData;
    const answerAnchor = `**The answer is ${q.answer ?? "Not provided"} — this is the official answer key and is authoritative.**${hasDiagram ? " The question contains a diagram which may be hard to read precisely from the image alone — when in doubt, trust the answer key over your reading of the diagram and work backwards to justify it." : ""} Your explanation MUST arrive at this answer. If your working seems to point at a different answer, you have misread the question or diagram — re-examine the question text and answer key, then explain how the official answer is reached.`;

    parts.push({
      text: `You are a helpful tutor for a primary school student.

Here is the question:
${questionText}

${answerAnchor}

Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it. Do NOT discuss what the student did wrong or why they lost marks — just teach the correct approach.

Keep the "solution" tight: aim for 120 words, hard cap at 150. Age-appropriate, encouraging, simple language. **Fractions MUST be written as inline LaTeX delimited by single dollar signs**. CRITICAL — your output is JSON, so backslashes inside string values MUST be DOUBLED: write \`$\\\\frac{3}{7}$\` (with TWO backslashes) inside the "solution" string, not \`$\\frac{3}{7}$\`. The JSON parser will turn the doubled backslash back into one. Same for mixed numbers: \`$3\\\\frac{1}{2}$\`. If you forget to double the backslash, JSON parsing will eat \`\\f\` as a form-feed and the fraction breaks. Other math stays plain text: x or * for multiply, ÷ for divide, x^2 for powers, = for equals. The only LaTeX command allowed is \\\\frac. Use **double asterisks** to bold step labels (**Step 1:**, **Answer:**) and key words inside each step (the operation, the value being computed, "**1 unit**", subject terms). No other markdown.

For Singapore-primary fraction or ratio word problems where the question gives one fraction of one quantity and another fraction of a *remainder* (e.g. "1/4 of total were X", "2/5 of the remaining were Y"), prefer the **units / model method** rather than algebra: pick a **common number of units** that makes both fractions whole, then express each part of the question in those units. Convert one known quantity into "1 unit = …" then read off the answer. This mirrors the answer-key format teachers use.
${mathHeuristicsBlock(q.examPaper.subject)}

${COMMON_DIAGRAM_RULES}`,
    });

    try {
      const response = await getAI().models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [{ role: "user", parts }],
      });
      const raw = response.text ?? "";
      const { solution, diagrams } = parseModelResponse(raw);
      const elaboration = solution || "Unable to generate explanation.";
      const cached = JSON.stringify({ solution: elaboration, diagrams });
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { elaboration: cached },
      });
      results.push({
        id: q.id, questionNum: q.questionNum, paperId: q.examPaperId,
        paperTitle: q.examPaper.title, subject: q.examPaper.subject ?? "?", level: q.examPaper.level ?? "?",
        ok: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Persist the failure so subsequent batches (and page
      // reloads) skip this row instead of looping on it. Stored
      // as a JSON sentinel so the per-card route can detect it
      // and re-attempt on demand.
      try {
        await prisma.examQuestion.update({
          where: { id: q.id },
          data: { elaboration: makeErrorSentinel(msg) },
        });
      } catch { /* DB hiccup — worst case we retry next batch */ }
      results.push({
        id: q.id, questionNum: q.questionNum, paperId: q.examPaperId,
        paperTitle: q.examPaper.title, subject: q.examPaper.subject ?? "?", level: q.examPaper.level ?? "?",
        ok: false, error: msg.slice(0, 160),
      });
    }
  }

  // totalRemaining = MCQ in scope still without elaboration. Cheap-ish
  // re-count via the same JS filter — admin endpoint, low call rate.
  const remainingCandidates = await prisma.examQuestion.findMany({
    where: { elaboration: null, examPaper: MASTER_SCOPE },
    select: { transcribedOptions: true, transcribedOptionImages: true, answer: true },
  });
  const totalRemaining = remainingCandidates.filter((q) => isMcqRow(q.transcribedOptions, q.transcribedOptionImages, q.answer)).length;

  return NextResponse.json({
    requested: limit,
    processed: results.length,
    updated: results.filter((r) => r.ok).length,
    totalRemaining,
    results,
  });
}
