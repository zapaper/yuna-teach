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

Solve the question. Output ONE labelled block per sub-part. Each block must be self-contained — repeat any shared working inside the block — so the renderer can show students the working that leads to THAT specific part's answer.

Format (mandatory):
  (a) Steps: Step 1: ... | Step 2: ... | Final answer: <a's answer>
  followed by " | "
  (b) Steps: Step 1: ... | Step 2: ... | Final answer: <b's answer>
  followed by " | "
  (c) ... etc.

Rules:
- DO NOT output a single shared "Steps: ..." block followed by a combined "Final answer: (a) X (b) Y" line. The (a) block must end with its OWN "Final answer: …" line, and the (b) block must start fresh with its label and its own steps + final answer. If the working for (a) and (b) is genuinely identical, duplicate it word-for-word under each label.
- Each step is ONE short sentence (≤ 20 words) with the actual calculation.
- 2–6 steps per sub-part is typical.
- "Final answer:" line carries the numeric/short answer with units.
- Use " | " as the separator between steps AND between sub-part blocks. Never use literal newlines inside the JSON string value.
- If a sub-part can't be solved from the available info (missing diagram etc.), output "(LABEL) Steps: Unable to solve from available info — needs admin attention. | Final answer: ?" for that label.

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

async function generateAnswer(q: {
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

  const withGap = candidates
    .map((q) => {
      const subs = realSubparts(q.transcribedSubparts);
      return { q, subs, marksGap: hasMarksGap(subs), answerGap: hasAnswerGap(q.answer, subs) };
    })
    .filter((r) => {
      if (r.subs.length < 2) return false;
      if (!(r.marksGap || r.answerGap)) return false;
      const subj = (r.q.examPaper.subject ?? "").toLowerCase();
      if (subjectFilter) return subj.includes(subjectFilter);
      return isMathOrScience(r.q.examPaper.subject);
    })
    .slice(0, limit);

  // Run both AI passes in parallel per candidate, then in
  // parallel across all candidates. Gemini handles ~10 concurrent
  // requests fine.
  const items = await Promise.all(
    withGap.map(async (r) => {
      const questionImageBase64 = r.q.imageData
        ? r.q.imageData.replace(/^data:image\/\w+;base64,/, "")
        : null;
      const diag = await shrinkImage(r.q.diagramImageData);
      const labels = r.subs.map((s) => s.label);

      const [marksResult, answerResult] = await Promise.all([
        r.marksGap && questionImageBase64
          ? extractSubpartMarks(questionImageBase64, labels).catch(() => ({}))
          : Promise.resolve({}),
        r.answerGap
          ? generateAnswer({
              stem: r.q.transcribedStem ?? "",
              subparts: r.subs,
              options: r.q.transcribedOptions,
              diagramBase64: diag,
              existingAnswer: r.q.answer,
            })
          : Promise.resolve({ answer: "" }),
      ]);

      const proposedMarks: Record<string, number> = (marksResult as Record<string, number>) ?? {};
      const proposedAnswer = "answer" in answerResult ? answerResult.answer : "";
      const aiError = "error" in answerResult ? answerResult.error : null;

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
    }),
  );

  return NextResponse.json({
    items,
    counted: items.length,
    scanned: candidates.length,
  });
}

// POST — apply admin's accepted proposals.
//   { action: "apply", id, newAnswer?, subpartMarks? }
// subpartMarks is { label: number } — appended as [N] to each
// matching sub-part text (only if the text doesn't already have
// a [N] marker). newAnswer overwrites the answer field verbatim.
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
      // sentinel labels (_drawable, _subref-*) untouched.
      type RawSubpart = { label: string; text: string; [k: string]: unknown };
      const all = q.transcribedSubparts as unknown as RawSubpart[];
      const updated = all.map((sp) => {
        if (sp.label.startsWith("_")) return sp;
        const m = subpartMarks[sp.label];
        if (!m || !Number.isFinite(m)) return sp;
        if (/\[\s*\d+\s*(?:m(?:ark)?s?)?\s*\]/i.test(String(sp.text ?? ""))) return sp;
        return { ...sp, text: `${String(sp.text ?? "").trim()} [${m}]`.trim() };
      });
      data.transcribedSubparts = updated as unknown as Prisma.InputJsonValue;
    }
  }
  await prisma.examQuestion.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}
