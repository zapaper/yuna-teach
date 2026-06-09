// Bulk-regenerate cached AI explanations for Science / Math MCQ
// questions that have a diagram. Drives the /admin/regen-mcq-diagrams
// page.
//
// Why a new route instead of extending /api/admin/elaborate-mcq:
// the existing route only processes rows where elaboration IS NULL —
// it's a one-shot pre-warmer. Regen needs to overwrite an existing
// cached elaboration when it was generated against the old
// diagram-only prompt that paraphrased in-diagram labels.
//
// Marker: each regenerated elaboration carries `"regenV2": true`
// inside the cached JSON, so GET counts can distinguish the freshly-
// regenerated rows from the legacy ones.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";
import { isSessionAdmin } from "@/lib/session";
import { mathHeuristicsBlock } from "@/lib/math-heuristics";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _ai;
}

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

const REGEN_MARKER = '"regenV2":true';
const MASTER_SCOPE = { sourceExamId: null, paperType: null } as const;

const letterSetRe = /^\s*(?:[A-D](?:\s*,\s*[A-D]){0,3}(?:\s+and\s+[A-D])?(?:\s+only)?|(?:I{1,3}|IV|V)(?:\s*,\s*(?:I{1,3}|IV|V)){0,3}(?:\s+and\s+(?:I{1,3}|IV|V))?(?:\s+only)?)\s*$/i;

function isLetterSetOpts(opts: unknown): boolean {
  if (!Array.isArray(opts) || opts.length !== 4) return false;
  return opts.every((o) => typeof o === "string" && letterSetRe.test(o as string));
}

function hasOpts(
  opts: unknown,
  optImgs: unknown,
  tbl: unknown,
): boolean {
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(optImgs) && optImgs.some((o) => !!o)) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (tbl && typeof tbl === "object" && Array.isArray((tbl as any).rows) && (tbl as any).rows.length === 4) return true;
  return false;
}

function parseModelResponse(text: string): { solution: string; diagrams: unknown[] } {
  let raw = text.trim();
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1].trim();
  try {
    const parsed = JSON.parse(raw) as { solution?: unknown; diagrams?: unknown };
    if (parsed && typeof parsed.solution === "string") {
      return { solution: parsed.solution, diagrams: Array.isArray(parsed.diagrams) ? parsed.diagrams : [] };
    }
  } catch { /* fall through */ }
  return { solution: text, diagrams: [] };
}

function toInlinePart(raw: string): { inlineData: { mimeType: string; data: string } } | null {
  const m = raw.match(/^data:image\/(\w+);base64,(.+)$/);
  if (m) return { inlineData: { mimeType: `image/${m[1] === "jpeg" ? "jpeg" : m[1]}`, data: m[2] } };
  if (raw.startsWith("/9j/")) return { inlineData: { mimeType: "image/jpeg", data: raw } };
  if (raw.startsWith("iVBORw0KGgo")) return { inlineData: { mimeType: "image/png", data: raw } };
  return null;
}

// GET — pool counts for the admin page.
// `letterSetOnly` query param narrows the scope to letter-set MCQs.
export async function GET(req: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const letterSetOnly = req.nextUrl.searchParams.get("letterSetOnly") === "1";

  const masters = await prisma.examPaper.findMany({
    where: {
      ...MASTER_SCOPE,
      OR: [
        { subject: { contains: "science", mode: "insensitive" } },
        { subject: { contains: "math", mode: "insensitive" } },
      ],
    },
    select: {
      questions: {
        where: { diagramImageData: { not: null } },
        select: {
          transcribedOptions: true,
          transcribedOptionImages: true,
          transcribedOptionTable: true,
          elaboration: true,
        },
      },
      subject: true,
    },
  });

  let total = 0, regenerated = 0, sci = 0, math = 0;
  for (const p of masters) {
    const sl = (p.subject ?? "").toLowerCase();
    const isSci = sl.includes("science");
    const isMath = sl.includes("math");
    for (const q of p.questions) {
      if (!hasOpts(q.transcribedOptions, q.transcribedOptionImages, q.transcribedOptionTable)) continue;
      if (letterSetOnly && !isLetterSetOpts(q.transcribedOptions)) continue;
      total++;
      if (isSci) sci++;
      else if (isMath) math++;
      if (q.elaboration && q.elaboration.includes(REGEN_MARKER)) regenerated++;
    }
  }
  return NextResponse.json({
    total,
    regenerated,
    pending: total - regenerated,
    sci,
    math,
  });
}

// POST — process the next `limit` un-regenerated questions in the scope.
// Body: { limit?: number, letterSetOnly?: boolean }
export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  // Concurrency 3 keeps under Gemini's per-minute limit for pro-preview
  // while shaving total wall time. limit caps at 20 to avoid hitting
  // the Vercel function timeout (~60s for hobby, ~300s for pro).
  const limit = Math.max(1, Math.min(20, Number(body.limit ?? 5)));
  const letterSetOnly = body.letterSetOnly === true;
  const ai = getAI();

  // Pull a slim scan first (no large columns) to pick the next batch.
  // Then re-fetch only those ids with full data for prompt building.
  const slim = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        ...MASTER_SCOPE,
        OR: [
          { subject: { contains: "science", mode: "insensitive" } },
          { subject: { contains: "math", mode: "insensitive" } },
        ],
      },
      diagramImageData: { not: null },
      // Skip already-regenerated rows. NULL elaboration is included so
      // first-time generation also happens here. Existing cached but
      // pre-v2 entries get overwritten.
      OR: [
        { elaboration: null },
        { elaboration: { not: { contains: REGEN_MARKER } } },
      ],
    },
    select: {
      id: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedOptionTable: true,
      answer: true,
    },
    orderBy: { id: "asc" },
  });
  const mcqIds: string[] = [];
  for (const q of slim) {
    if (!hasOpts(q.transcribedOptions, q.transcribedOptionImages, q.transcribedOptionTable)) continue;
    if (letterSetOnly && !isLetterSetOpts(q.transcribedOptions)) continue;
    mcqIds.push(q.id);
    if (mcqIds.length >= limit) break;
  }

  if (mcqIds.length === 0) {
    return NextResponse.json({ done: true, processed: 0, results: [] });
  }

  const questions = await prisma.examQuestion.findMany({
    where: { id: { in: mcqIds } },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedOptionTable: true,
      transcribedSubparts: true,
      diagramImageData: true,
      imageData: true,
      answer: true,
      examPaper: { select: { title: true, subject: true, level: true } },
    },
  });

  type Outcome = { id: string; questionNum: string; paperTitle: string; ok: boolean; letterSet: boolean; error?: string };
  const outcomes: Outcome[] = [];

  // Process with limited concurrency (3 in flight).
  const queue = [...questions];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length > 0) {
      const q = queue.shift();
      if (!q) break;
      const opts = q.transcribedOptions as string[] | null;
      const isLetterSet = isLetterSetOpts(opts);
      let questionText = q.transcribedStem ?? `Question ${q.questionNum}`;
      if (opts && opts.length > 0) {
        questionText += "\n" + opts.map((o, i) => `(${i + 1}) ${o}`).join("\n");
      }
      const subs = q.transcribedSubparts as { label: string; text: string }[] | null;
      if (subs && subs.length > 0) {
        questionText += "\n" + subs.filter((s) => s.label !== "_drawable").map((s) => `(${s.label}) ${s.text}`).join("\n");
      }

      const parts: ({ text?: string } | { inlineData: { mimeType: string; data: string } })[] = [];
      // Send diagram crop + full question crop together — the diagram
      // crop is sharper for figures, the full crop preserves labels
      // (especially statement texts A/B/C/D).
      if (q.diagramImageData) {
        const p = toInlinePart(q.diagramImageData);
        if (p) parts.push(p);
      }
      if (q.imageData) {
        const p = toInlinePart(q.imageData);
        if (p) parts.push(p);
      }

      const hasDiagram = !!q.diagramImageData;
      const answerAnchor =
        `**The answer is ${q.answer ?? "Not provided"} — this is the official answer key and is authoritative.**` +
        (hasDiagram
          ? " The question contains a diagram which may be hard to read precisely from the image alone — when in doubt, trust the answer key over your reading of the diagram and work backwards to justify it."
          : "") +
        " Your explanation MUST arrive at this answer. If your working seems to point at a different answer, you have misread the question or diagram — re-examine and explain how the official answer is reached.";

      const letterSetRule = isLetterSet ? `
LABELLED-ITEM MCQ — CRITICAL:
The options are letter-set references (e.g. "A, B and C only"). The labelled items A, B, C, D (or I, II, III…)
live as printed text ON the diagram, NOT in the text portion of this prompt. Before reasoning, in this order:
  1. Transcribe each labelled item VERBATIM from the image. Use the format:
       Statement A: "<exact text>"
       Statement B: "<exact text>"
       …
     If a label is unreadable, write "Statement X: (unreadable)" — never paraphrase or invent text.
  2. Verify EACH labelled statement TRUE or FALSE against the diagram / data table, citing the specific row,
     column, or feature you used.
  3. ONLY after steps 1 and 2 write the final "Step 1 / Step 2 / Answer" explanation that arrives at the
     official answer.
` : "";

      const wordTarget = isLetterSet ? 200 : 120;
      const wordCap = isLetterSet ? 250 : 150;
      const prompt = `You are a helpful tutor for a primary school student.

Here is the question:
${questionText}

${answerAnchor}
${letterSetRule}
Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it.

Keep the "solution" tight: aim for ${wordTarget} words, hard cap at ${wordCap}. Age-appropriate, encouraging, simple language. **Fractions MUST be written as inline LaTeX delimited by single dollar signs**. CRITICAL — your output is JSON, so backslashes inside string values MUST be DOUBLED: write \`$\\\\frac{3}{7}$\` (with TWO backslashes) inside the "solution" string, not \`$\\frac{3}{7}$\`. Other math stays plain text: x or * for multiply, ÷ for divide, x^2 for powers. The only LaTeX command allowed is \\\\frac. Use **double asterisks** to bold step labels and key terms. No other markdown.

${mathHeuristicsBlock(q.examPaper.subject)}

${COMMON_DIAGRAM_RULES}`;

      parts.push({ text: prompt });

      try {
        const resp = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: [{ role: "user", parts }],
        });
        const text = resp.text ?? "";
        const { solution, diagrams } = parseModelResponse(text);
        const cached = JSON.stringify({ solution: solution || "Unable to generate explanation.", diagrams, regenV2: true });
        await prisma.examQuestion.update({
          where: { id: q.id },
          data: { elaboration: cached },
        });
        outcomes.push({ id: q.id, questionNum: q.questionNum, paperTitle: q.examPaper.title, ok: true, letterSet: isLetterSet });
      } catch (err) {
        outcomes.push({
          id: q.id,
          questionNum: q.questionNum,
          paperTitle: q.examPaper.title,
          ok: false,
          letterSet: isLetterSet,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
  await Promise.all(workers);

  return NextResponse.json({
    done: false,
    processed: outcomes.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    letterSet: outcomes.filter((o) => o.letterSet).length,
    results: outcomes,
  });
}
