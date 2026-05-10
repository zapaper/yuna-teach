import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { extractSubpartMarks } from "@/lib/gemini";

// Unified admin tool for clean-extract Math/Science OEQs with
// sub-parts. Surfaces two kinds of gap on the same row and
// proposes AI fixes for both:
//
//   (a) Per-part mark allocation — `[2]` markers in the question
//       text that the extractor missed for older papers. We use
//       extractSubpartMarks (existing helper) to read them off the
//       question image.
//
//   (b) Per-part answer key — when the stored `answer` field
//       doesn't mention every (a)/(b)/(c) label, the renderer has
//       nothing to show for the missing parts. We ask Gemini to
//       solve all sub-parts and return a labelled block.
//
// Both passes run in parallel for each candidate. The page lets
// the admin review proposals, edit if needed, and apply (or skip).
// First batch of 10, then continuous after manual approval.

export const maxDuration = 300;

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY ?? "",
  httpOptions: { timeout: 90_000 },
});

const SOLVE_PROMPT = `You are a Singapore primary-school maths/science teacher writing answer keys.

Solve the question. The output MUST be organised by sub-part. Each sub-part gets its own labelled block with its own steps and its own final answer. NEVER produce one shared block of steps with the per-part answers tagged at the end.

REQUIRED format (this is non-negotiable):
  "(a) Steps: <step 1> | <step 2> | ... | Final answer: <answer for a> | (b) Steps: <step 1> | <step 2> | ... | Final answer: <answer for b> | (c) Steps: ... | Final answer: ..."

WRONG format (do NOT produce this):
  "Steps: <step 1> | <step 2> | ... | Final answer: (a) X (b) Y"
  This is the format the source material often uses. Your job is to RE-ORGANISE it into the per-part format above.

Rules:
- The (a) block STARTS with "(a) Steps: Step 1:" and ENDS with its own "Final answer: <a's answer>". The very first clause inside Steps MUST be labelled "Step 1:" — do not skip the label.
- Then a " | " separator.
- Then the (b) block STARTS with "(b) Steps: Step 1:" and ENDS with its own "Final answer: <b's answer>". (b)'s steps re-start at "Step 1:" — they do NOT continue numbering from (a)'s last step.
- If the working for (a) and (b) is genuinely the same shared computation, REPEAT the working steps word-for-word inside each block (re-numbered Step 1..N for each block). Repetition is intentional — the renderer slices the answer string by label and shows each block to the student under their respective sub-part.
- Each step is ONE short sentence (≤ 20 words) with the actual calculation.
- 2–6 steps per sub-part is typical.
- Use " | " as the separator. Never use literal newlines inside the JSON string value.
- If a sub-part can't be solved from the available info, output "(LABEL) Steps: Step 1: Unable to solve from available info — needs admin attention. | Final answer: ?".

LaTeX math (CRITICAL):
- Wrap fractions, mixed numbers, exponents, and roots in single dollar signs so the renderer stacks them properly:
    proper fraction:   $\\frac{7}{27}$    (NOT 7/27)
    mixed number:      $4\\frac{5}{6}$    (NOT 4 5/6)
    exponent:          $5^2$              (NOT 5^2 or 5²)
    square root:       $\\sqrt{16}$        (NOT √16)
- Plain integers, decimals, percentages, currency, units stay as-is.

Return ONLY valid JSON: { "answer": "(a) Steps: ... Final answer: ... | (b) Steps: ... Final answer: ..." }

Example for a question where parts (a) and (b) share the same working:
  "answer": "(a) Steps: Step 1: $1 - \\frac{4}{9} - \\frac{1}{2} = \\frac{1}{18}$ | Step 2: 1 unit → 36 eggs | Step 3: 9 × 36 = 324 | Final answer: 324 | (b) Steps: Step 1: $1 - \\frac{4}{9} - \\frac{1}{2} = \\frac{1}{18}$ | Step 2: 1 unit → 36 eggs | Step 3: 9 × 36 = 324 | Step 4: 30 × 12 = 360 | Step 5: 360 - 324 = 36 | Step 6: 36 ÷ 2 = 18 | Final answer: 18"`;

type Subpart = { label: string; text: string };

function realSubparts(subparts: unknown): Subpart[] {
  if (!Array.isArray(subparts)) return [];
  return (subparts as Subpart[]).filter(
    (s) => s && typeof s.label === "string" && !s.label.startsWith("_") && typeof s.text === "string",
  );
}

function hasMarksGap(subparts: Subpart[]): boolean {
  if (subparts.length < 2) return false;
  // Gap exists when at least one sub-part text doesn't have a [N] marker
  return subparts.some((s) => !/\[\s*\d+\s*(?:m(?:ark)?s?)?\s*\]/i.test(s.text));
}

function hasAnswerGap(answer: string | null, subparts: Subpart[]): boolean {
  if (subparts.length < 2) return false;
  const ans = (answer ?? "").toLowerCase();
  return subparts.some((s) => !ans.includes(`(${s.label.toLowerCase()})`));
}

function isMathOrScience(s: string | null | undefined): boolean {
  const v = (s ?? "").toLowerCase();
  return v.includes("math") || v.includes("science");
}

async function shrinkImage(base64: string | null | undefined): Promise<string | null> {
  if (!base64) return null;
  try {
    const clean = base64.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(clean, "base64");
    const out = await sharp(buf)
      .resize({ width: 720, height: 1200, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return out.toString("base64");
  } catch {
    return null;
  }
}

// Tolerant check: does the answer string LOOK like the per-part
// format we asked for? Must begin with "(a)" (allowing leading
// whitespace) so the renderer's parsePartAnswers slices cleanly.
// Sometimes the AI emits "Steps: ..." with the (a) label dropped
// or "14a) Steps: ..." which doesn't slice the same way.
function looksWellFormed(answer: string): boolean {
  return /^\s*\(a\)/i.test(answer.trim());
}

async function generateAnswerOnce(q: {
  stem: string;
  subparts: Subpart[];
  options: unknown;
  diagramBase64: string | null;
  existingAnswer: string | null;
}): Promise<{ answer: string } | { error: string }> {
  const optList = Array.isArray(q.options)
    ? (q.options as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0)
    : [];
  const lines = [
    SOLVE_PROMPT,
    "",
    `Question: ${q.stem || "(stem missing — solve from the diagram)"}`,
    ...q.subparts.map((s) => `(${s.label}) ${s.text}`),
    ...optList.map((o, i) => `Option (${i + 1}): ${o}`),
    `Existing partial answer key: ${q.existingAnswer ?? "(none)"}`,
  ];
  type Part = { text: string } | { inlineData: { mimeType: "image/jpeg"; data: string } };
  const parts: Part[] = [{ text: lines.join("\n") }];
  if (q.diagramBase64) parts.push({ inlineData: { mimeType: "image/jpeg", data: q.diagramBase64 } });
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    });
    const text = (resp.text ?? "").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(text) as { answer?: string };
    if (!parsed.answer) return { error: "AI returned no answer" };
    return { answer: parsed.answer };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI call failed" };
  }
}

// generateAnswer wraps the single-call helper with one auto-retry
// when the first attempt's payload doesn't start with "(a)" — the
// renderer's parsePartAnswers slices on labels, and a missing
// leading "(a)" leaks the whole answer under part (a) only. The
// admin used to fix this manually with the Re-run AI button; we
// now do it automatically up front.
//
// If retry ALSO fails, programmatically prepend "(a) " when the
// payload looks like it has later labels ("(b)", etc.) but is
// missing the leading one. Better to risk a misattributed
// section than serve up a literally-unparsable answer.
async function generateAnswer(q: Parameters<typeof generateAnswerOnce>[0]): Promise<{ answer: string } | { error: string }> {
  const first = await generateAnswerOnce(q);
  if ("error" in first) return first;
  if (looksWellFormed(first.answer)) return first;
  console.log(`[answer-key-gaps] first attempt malformed (no leading "(a)"), retrying once`);
  const second = await generateAnswerOnce(q);
  // If retry also returned an error, fall back to first.
  const candidate = "error" in second ? first.answer : (looksWellFormed(second.answer) ? second.answer : first.answer);
  if (looksWellFormed(candidate)) return { answer: candidate };
  // Last-resort fixup: if there's a "(b)" or "(c)" later in the
  // string, the AI gave us per-part working but forgot to label
  // the first block. Prepend "(a) ".
  if (/\(([b-f])\)/i.test(candidate)) {
    console.log(`[answer-key-gaps] prepending missing "(a) " label after both retries`);
    return { answer: `(a) ${candidate.trim()}` };
  }
  return { answer: candidate };
}

// GET — surface up to 30 candidates with both gap types + AI
// proposals. Excludes ids the admin already reviewed in this
// session.
export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const excludeRaw = request.nextUrl.searchParams.get("excludeIds");
  const excludeIds = excludeRaw ? excludeRaw.split(",").filter(Boolean) : [];
  const limit = Math.min(30, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 10)));
  // Subject filter — defaults to "math" since the user wants to
  // burn through math OEQs first, then move on to science.
  const subjectParam = (request.nextUrl.searchParams.get("subject") ?? "math").toLowerCase();
  const subjectFilter = subjectParam === "all" ? null : subjectParam;
  // listOnly=1 → return the full universe of matching IDs as a
  // fast (no AI) preflight. The page calls this once on mount to
  // establish the total backlog, then makes per-batch AI calls
  // by passing ?ids=a,b,c on subsequent requests. Avoids the
  // re-scan-every-batch behaviour.
  const listOnly = request.nextUrl.searchParams.get("listOnly") === "1";
  const idsParam = request.nextUrl.searchParams.get("ids");
  const onlyIds = idsParam ? idsParam.split(",").filter(Boolean) : null;

  // Pre-filter at DB level. Re-narrow in JS because gap checks need
  // JSON parsing.
  const subjectClause = subjectFilter
    ? [{ subject: { contains: subjectFilter, mode: "insensitive" as const } }]
    : [
        { subject: { contains: "math", mode: "insensitive" as const } },
        { subject: { contains: "science", mode: "insensitive" as const } },
      ];
  const candidates = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        OR: subjectClause,
        NOT: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
      transcribedSubparts: { not: Prisma.AnyNull },
      transcribedStem: { not: null },
      imageData: { not: "" },
      ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedSubparts: true,
      transcribedOptions: true,
      answer: true,
      answerImageData: true,
      imageData: true,
      diagramImageData: true,
      marksAvailable: true,
      examPaper: { select: { id: true, title: true, level: true, subject: true } },
    },
    orderBy: { id: "asc" },
    take: 500,
  });

  // For Science, the user only wants per-part mark allocation
  // fixed — the answer-key generation step is skipped because the
  // existing science answer keys are usually descriptive sentences
  // we don't want to overwrite. So a science row counts as a "gap"
  // ONLY if it has a marks gap. Math rows surface for either gap.
  const allWithGap = candidates
    .map((q) => {
      const subs = realSubparts(q.transcribedSubparts);
      return { q, subs, marksGap: hasMarksGap(subs), answerGap: hasAnswerGap(q.answer, subs) };
    })
    .filter((r) => {
      if (r.subs.length < 2) return false;
      const subj = (r.q.examPaper.subject ?? "").toLowerCase();
      if (subjectFilter && !subj.includes(subjectFilter)) return false;
      if (!subjectFilter && !isMathOrScience(r.q.examPaper.subject)) return false;
      const isScience = subj.includes("science");
      if (isScience) return r.marksGap;
      // Math (and "all" with non-science fall-through)
      return r.marksGap || r.answerGap;
    });
  const total = allWithGap.length;

  // Fast preflight: page asked for just the universe of IDs so it
  // can stop re-scanning the DB on every batch. No AI work here.
  if (listOnly) {
    return NextResponse.json({
      ids: allWithGap.map((r) => r.q.id),
      totalPending: total,
    });
  }

  // Batched AI fill: when a list of specific IDs is provided,
  // process exactly those. Otherwise default to the first `limit`
  // matching candidates (legacy behaviour kept for first scan
  // before the page started passing ?ids=).
  const withGap = onlyIds && onlyIds.length > 0
    ? allWithGap.filter((r) => onlyIds.includes(r.q.id))
    : allWithGap.slice(0, limit);

  // Run AI passes per candidate. Two calls per candidate
  // (extractSubpartMarks + generateAnswer) in parallel inside the
  // row, but cap concurrency ACROSS rows so we don't fire 20
  // simultaneous Gemini calls — that hit rate limits and the
  // whole batch stalled. CONCURRENCY=3 keeps the active call
  // count at 6 max, well under Gemini's free-tier ceiling.
  const CONCURRENCY = 3;
  const queue = [...withGap];
  const results: Array<typeof withGap[number] & {
    proposedMarks: Record<string, number>;
    proposedAnswer: string;
    aiError: string | null;
    diag: string | null;
  }> = [];
  async function worker() {
    while (queue.length > 0) {
      const r = queue.shift();
      if (!r) break;
      try {
        const questionImageBase64 = r.q.imageData
          ? r.q.imageData.replace(/^data:image\/\w+;base64,/, "")
          : null;
        const diag = await shrinkImage(r.q.diagramImageData);
        const labels = r.subs.map((s) => s.label);
        const [marksResult, answerResult] = await Promise.all([
          r.marksGap && questionImageBase64
            ? extractSubpartMarks(questionImageBase64, labels).catch(() => ({} as Record<string, number>))
            : Promise.resolve({} as Record<string, number>),
          r.answerGap && !((r.q.examPaper.subject ?? "").toLowerCase().includes("science"))
            ? generateAnswer({
                stem: r.q.transcribedStem ?? "",
                subparts: r.subs,
                options: r.q.transcribedOptions,
                diagramBase64: diag,
                existingAnswer: r.q.answer,
              })
            : Promise.resolve({ answer: "" }),
        ]);
        const proposedMarks = (marksResult as Record<string, number>) ?? {};
        const proposedAnswer = "answer" in answerResult ? answerResult.answer : "";
        const aiError = "error" in answerResult ? answerResult.error : null;
        results.push({ ...r, proposedMarks, proposedAnswer, aiError, diag });
      } catch (e) {
        results.push({
          ...r,
          proposedMarks: {},
          proposedAnswer: "",
          aiError: e instanceof Error ? e.message : "AI failed",
          diag: null,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  // Restore original order — workers pop off the queue in
  // arbitrary timing order otherwise.
  results.sort((a, b) => withGap.findIndex((x) => x.q.id === a.q.id) - withGap.findIndex((x) => x.q.id === b.q.id));

  const items = results.map((r) => {
      const proposedMarks: Record<string, number> = { ...r.proposedMarks };
      const proposedAnswer = r.proposedAnswer;
      const aiError = r.aiError;

      // Even-split fallback: when the AI couldn't read any [N]
      // markers off the question image but we know the total
      // marks AND the parts divide evenly into it (e.g. 2 marks
      // across 2 parts → 1 each, 6 across 3 parts → 2 each), seed
      // the proposed marks with the obvious split. Admin can still
      // override before applying.
      const labelsList = r.subs.map((s) => s.label);
      const total = r.q.marksAvailable;
      if (
        Object.keys(proposedMarks).length === 0 &&
        typeof total === "number" &&
        total > 0 &&
        labelsList.length > 0 &&
        total % labelsList.length === 0
      ) {
        const each = total / labelsList.length;
        for (const lbl of labelsList) proposedMarks[lbl] = each;
      }

      // Pre-existing per-part marks scraped from the subpart text
      // (the [N] markers we already write). Lets the page show
      // "before" — current per-part marks — alongside "after".
      const currentMarks: Record<string, number> = {};
      for (const s of r.subs) {
        const m = String(s.text ?? "").match(/\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i);
        if (m) currentMarks[s.label] = parseInt(m[1], 10);
      }

      return {
        id: r.q.id,
        questionNum: r.q.questionNum,
        paperId: r.q.examPaper.id,
        paperTitle: r.q.examPaper.title,
        level: r.q.examPaper.level,
        subject: r.q.examPaper.subject,
        stem: r.q.transcribedStem ?? "",
        subparts: r.subs,
        currentAnswer: r.q.answer ?? "",
        currentMarks,
        currentMarksAvailable: r.q.marksAvailable,
        // Show whether a diagram / answer image exists; the page
        // can fetch /api/exam/.../question/<id>/image for the
        // raw bytes if it wants to display them.
        hasDiagram: !!r.q.diagramImageData,
        hasAnswerImage: !!r.q.answerImageData,
        marksGap: r.marksGap,
        answerGap: r.answerGap,
        proposedMarks,
        proposedAnswer,
        aiError,
      };
    });

  return NextResponse.json({
    items,
    counted: items.length,
    scanned: candidates.length,
    totalPending: total,
  });
}

// POST — two actions:
//   { action: "apply", id, newAnswer?, subpartMarks? }
//     Apply admin's accepted proposals. subpartMarks is
//     { label: number } — appended as [N] to each matching
//     sub-part text (only if the text doesn't already have a [N]
//     marker). newAnswer overwrites the answer field verbatim.
//   { action: "regenerate", id }
//     Re-run the AI solver for one row WITHOUT saving — admin
//     uses this when the first proposal was poorly formatted
//     (e.g. shared-block instead of per-part) and wants Gemini
//     to try again. Returns the same shape as a single GET item
//     so the page can reseed editAnswer for that row.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const { action, id, newAnswer, subpartMarks } = body as {
    action?: string;
    id?: string;
    newAnswer?: string;
    subpartMarks?: Record<string, number>;
  };
  if (action === "regenerate" && id) {
    const q = await prisma.examQuestion.findUnique({
      where: { id },
      select: {
        transcribedStem: true,
        transcribedSubparts: true,
        transcribedOptions: true,
        diagramImageData: true,
        answer: true,
      },
    });
    if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });
    const subs = realSubparts(q.transcribedSubparts);
    const diag = await shrinkImage(q.diagramImageData);
    const result = await generateAnswer({
      stem: q.transcribedStem ?? "",
      subparts: subs,
      options: q.transcribedOptions,
      diagramBase64: diag,
      existingAnswer: q.answer,
    });
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    return NextResponse.json({ proposedAnswer: result.answer });
  }
  if (action !== "apply" || !id) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const q = await prisma.examQuestion.findUnique({
    where: { id },
    select: { transcribedSubparts: true },
  });
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  const data: Prisma.ExamQuestionUpdateInput = {
    flagged: false,
    flaggedAt: null,
    markingNotes: null,
  };
  if (typeof newAnswer === "string" && newAnswer.trim()) {
    data.answer = newAnswer.trim();
  }
  if (subpartMarks && typeof subpartMarks === "object") {
    const existing = realSubparts(q.transcribedSubparts);
    const labelsWithMarks = Object.keys(subpartMarks).filter((l) => Number.isFinite(subpartMarks[l]));
    if (labelsWithMarks.length > 0 && existing.length > 0) {
      // Update text for each subpart we have marks for; keep
      // sentinel labels (_drawable, _subref-*) untouched. If the
      // text ALREADY has a [N] marker we REPLACE it with the
      // admin's edited value — previously we no-op'd, which made
      // the admin's correction look like it had saved when the
      // existing wrong-mark stayed in place.
      type RawSubpart = { label: string; text: string; [k: string]: unknown };
      const all = q.transcribedSubparts as unknown as RawSubpart[];
      const markRe = /\[\s*\d+\s*(?:m(?:ark)?s?)?\s*\]/i;
      const updated = all.map((sp) => {
        if (sp.label.startsWith("_")) return sp;
        const m = subpartMarks[sp.label];
        if (!Number.isFinite(m)) return sp;
        const text = String(sp.text ?? "");
        const newText = markRe.test(text)
          ? text.replace(markRe, `[${m}]`)
          : `${text.trim()} [${m}]`;
        return { ...sp, text: newText.trim() };
      });
      data.transcribedSubparts = updated as unknown as Prisma.InputJsonValue;
    }
  }
  await prisma.examQuestion.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}
