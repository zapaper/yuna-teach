import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { isSessionAdmin } from "@/lib/session";

// Scope: clean-extracted master Math questions at difficulty 4-5 whose answer
// key isn't already in our step-by-step format and that haven't been flagged
// or explicitly skipped. We mark rows by repurposing existing fields:
//   processed → answer prefixed with "Steps:"
//   mismatch  → flagged=true + markingNotes prefixed "[answer-steps mismatch]"
//   skipped   → markingNotes prefixed "[answer-steps skipped]" (NOT flagged)
// All three exclude the row from future scope.
const PROCESSED_PREFIX = "Steps:";
const SKIPPED_PREFIX = "[answer-steps skipped]";

function buildScope(extra?: Prisma.ExamQuestionWhereInput): Prisma.ExamQuestionWhereInput {
  return {
    transcribedStem: { not: null },
    difficulty: { in: [4, 5] },
    flagged: false,
    NOT: [
      { answer: { startsWith: PROCESSED_PREFIX } },
      { markingNotes: { startsWith: SKIPPED_PREFIX } },
    ],
    examPaper: {
      subject: "Mathematics",
      sourceExamId: null,
      paperType: null,
      NOT: [
        { examType: "Synthetic" },
        { title: { startsWith: "[Synthetic Bank]" } },
      ],
    },
    ...extra,
  };
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });

// One-line steps, then "Final answer: ..." on its own line. matchesKey is
// the AI's own judgement of whether its final answer is mathematically
// equivalent to the existing key — saves us from brittle string compares.
const STEP_PROMPT = `You are a P4-P6 Singapore primary Maths teacher writing answer keys for students. Your steps must teach the reasoning, not just present the answer.

For the question below:
1. Solve it yourself, showing concise step-by-step working.
   - Each step on its own line, starting "Step 1:", "Step 2:", etc.
   - Each step is ONE short sentence (≤ 20 words) explaining one operation or piece of reasoning.
   - Show the actual calculation in each step (e.g. "12 × 3 = 36").
   - Total steps usually 2–6.
2. End with "Final answer: ..." on its own line — just the numeric/short answer, with units if relevant.
3. Compare YOUR final answer to the EXISTING answer key.
   - Set matchesKey=true ONLY if mathematically equivalent (formatting/units differences are fine; different numbers are not).
   - If matchesKey=false, give a short mismatchReason (5–15 words) explaining how they differ.

Return ONLY valid JSON:
{
  "stepByStep": "Step 1: ...\\nStep 2: ...\\n...\\nFinal answer: ...",
  "finalAnswer": "...",
  "matchesKey": true/false,
  "mismatchReason": "..."
}`;

type AiOut = {
  stepByStep: string;
  finalAnswer: string;
  matchesKey: boolean;
  mismatchReason: string;
};

async function shrinkDiagram(base64: string | null | undefined): Promise<string | null> {
  if (!base64) return null;
  try {
    const clean = base64.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(clean, "base64");
    const out = await sharp(buf)
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return out.toString("base64");
  } catch {
    return null;
  }
}

type Subpart = { label: string; text: string };

async function generateForQuestion(q: {
  id: string;
  stem: string;
  options: unknown;
  subparts: unknown;
  answer: string | null;
  diagramBase64: string | null;
}): Promise<AiOut | { error: string }> {
  const optList = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0) : [];
  const subparts: Subpart[] = Array.isArray(q.subparts)
    ? q.subparts.filter((s): s is Subpart => !!s && typeof s === "object" && typeof (s as Subpart).label === "string" && typeof (s as Subpart).text === "string")
    : [];
  const lines = [
    STEP_PROMPT,
    "",
    `Question: ${q.stem}`,
    ...(subparts.length > 0 ? subparts.map(s => `(${s.label}) ${s.text}`) : []),
    ...(optList.length > 0 ? optList.map((o, i) => `Option (${i + 1}): ${o}`) : []),
    `Existing answer key: ${q.answer ?? "(blank)"}`,
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
    const parsed = JSON.parse(text) as Partial<AiOut>;
    if (!parsed.stepByStep) return { error: "AI returned no stepByStep" };
    return {
      stepByStep: String(parsed.stepByStep),
      finalAnswer: String(parsed.finalAnswer ?? ""),
      matchesKey: !!parsed.matchesKey,
      mismatchReason: String(parsed.mismatchReason ?? ""),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI call failed" };
  }
}

// GET — counts. How many candidates are still pending.
export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pending = await prisma.examQuestion.count({ where: buildScope() });
  const processed = await prisma.examQuestion.count({
    where: {
      answer: { startsWith: PROCESSED_PREFIX },
      difficulty: { in: [4, 5] },
      examPaper: { subject: "Mathematics" },
    },
  });
  const flaggedByThisRun = await prisma.examQuestion.count({
    where: {
      flagged: true,
      difficulty: { in: [4, 5] },
      markingNotes: { startsWith: "[answer-steps mismatch]" },
      examPaper: { subject: "Mathematics" },
    },
  });
  return NextResponse.json({ pending, processed, flagged: flaggedByThisRun });
}

// POST — two actions:
//   { action: "preview", limit, excludeIds } → run AI on N pending rows but
//     don't save. Returns full preview rows for the admin to review.
//   { action: "apply", items: [{id, stepByStep, finalAnswer, matchesKey, mismatchReason}] }
//     → save approved rows: matching → update answer, mismatch → flag.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const action = String(body.action ?? "preview");

  if (action === "preview") {
    const limit = Math.min(30, Math.max(1, Number(body.limit ?? 20)));
    const rawExclude = body.excludeIds;
    const excludeIds: string[] = Array.isArray(rawExclude)
      ? rawExclude.filter((x: unknown): x is string => typeof x === "string")
      : [];
    // Fetch a buffer larger than `limit` because we filter MCQs out post-
    // fetch. MCQ answer keys ("1", "C", "(2)") aren't multi-step, and
    // overwriting them with "Steps:\n..." would destroy the option index
    // the marker uses to grade student picks. Two heuristics:
    //   transcribedOptions has ≥ 2 non-empty strings → it's MCQ
    //   answer matches a single 1-4 / A-D pattern → it's MCQ
    const fetchTake = limit * 3;
    const rows = await prisma.examQuestion.findMany({
      where: buildScope(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : undefined),
      select: {
        id: true, questionNum: true, transcribedStem: true,
        transcribedOptions: true, transcribedSubparts: true,
        answer: true, diagramImageData: true,
        examPaper: { select: { title: true, level: true, subject: true } },
      },
      orderBy: { id: "asc" },
      take: fetchTake,
    });
    const oeqRows = rows.filter((r) => {
      const opts = Array.isArray(r.transcribedOptions)
        ? (r.transcribedOptions as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0)
        : [];
      if (opts.length >= 2) return false;
      const a = (r.answer ?? "").trim();
      if (/^\(?[1-4A-Da-d]\)?$/.test(a)) return false;
      // Also catch "X or Y" (e.g. "3 or 4", "(1) or (3)") — same heuristic
      // used in marking.ts isMcqAnswer.
      const normalized = a.replace(/[().]/g, "").trim();
      const parts = normalized.split(/\s+or\s+/).map(p => p.trim());
      if (parts.length > 1 && parts.every(p => /^[1-4A-Da-d]$/.test(p))) return false;
      return true;
    }).slice(0, limit);
    const out = await Promise.all(oeqRows.map(async (r) => {
      const diag = await shrinkDiagram(r.diagramImageData);
      const ai = await generateForQuestion({
        id: r.id,
        stem: r.transcribedStem ?? "",
        options: r.transcribedOptions,
        subparts: r.transcribedSubparts,
        answer: r.answer,
        diagramBase64: diag,
      });
      const base = {
        id: r.id,
        questionNum: r.questionNum,
        paperTitle: r.examPaper.title,
        stem: r.transcribedStem ?? "",
        subparts: Array.isArray(r.transcribedSubparts) ? r.transcribedSubparts : null,
        existingAnswer: r.answer ?? "",
        // Keep the original diagram (untransformed) for display in the UI —
        // the shrunk one was just for the AI call.
        diagramImageData: r.diagramImageData ?? null,
      };
      if ("error" in ai) return { ...base, error: ai.error };
      return {
        ...base,
        stepByStep: ai.stepByStep,
        finalAnswer: ai.finalAnswer,
        matchesKey: ai.matchesKey,
        mismatchReason: ai.mismatchReason,
      };
    }));
    return NextResponse.json({ items: out });
  }

  if (action === "apply") {
    type ApplyItem = { id: string; stepByStep: string; finalAnswer: string; matchesKey: boolean; mismatchReason: string };
    const items: ApplyItem[] = Array.isArray(body.items) ? (body.items as ApplyItem[]) : [];
    const rawSkipped = body.skippedIds;
    const skippedIds: string[] = Array.isArray(rawSkipped)
      ? rawSkipped.filter((x: unknown): x is string => typeof x === "string")
      : [];
    let updated = 0;
    let flagged = 0;
    let skipped = 0;
    for (const it of items) {
      if (!it?.id) continue;
      if (it.matchesKey) {
        // Replace `answer` with the prefixed step-by-step. The PROCESSED_PREFIX
        // is what we filter on so the same row never resurfaces.
        const newAnswer = `${PROCESSED_PREFIX}\n${it.stepByStep}`;
        await prisma.examQuestion.update({
          where: { id: it.id },
          data: { answer: newAnswer },
        });
        updated++;
      } else {
        // Mismatch — keep the existing answer untouched, flag the question
        // so the admin can review against the AI's reasoning later. Note
        // tagged so the GET counter can find these without scanning text.
        await prisma.examQuestion.update({
          where: { id: it.id },
          data: {
            flagged: true,
            flaggedAt: new Date(),
            markingNotes: `[answer-steps mismatch] AI: ${it.finalAnswer} | ${it.mismatchReason}\n\nAI working:\n${it.stepByStep}`,
          },
        });
        flagged++;
      }
    }
    // Persist explicit skips so they don't resurface on the next preview or
    // after a page reload. Not flagged — admin doesn't need to review.
    for (const id of skippedIds) {
      await prisma.examQuestion.update({
        where: { id },
        data: { markingNotes: `${SKIPPED_PREFIX} (admin chose not to apply)` },
      });
      skipped++;
    }
    return NextResponse.json({ updated, flagged, skipped });
  }

  if (action === "revert-mcq") {
    // Recovery: find rows where the answer was overwritten with "Steps:..."
    // BUT the row is actually an MCQ (transcribedOptions has ≥2 strings).
    // Parse the AI's "Final answer: X" out of the Steps body; if it matches
    // a single 1-4 / A-D pattern, restore answer to just that. Otherwise
    // skip (admin will fix manually).
    const rows = await prisma.examQuestion.findMany({
      where: {
        answer: { startsWith: PROCESSED_PREFIX },
        examPaper: { subject: "Mathematics" },
      },
      select: { id: true, answer: true, questionNum: true, transcribedOptions: true },
    });
    let reverted = 0;
    let skipped = 0;
    const skippedDetails: { id: string; questionNum: string; reason: string }[] = [];
    for (const r of rows) {
      const opts = Array.isArray(r.transcribedOptions)
        ? (r.transcribedOptions as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0)
        : [];
      if (opts.length < 2) continue; // not MCQ — leave alone
      const body = r.answer ?? "";
      const m = body.match(/Final answer:\s*(.+?)\s*$/im);
      const candidate = m ? m[1].trim() : "";
      // Accept single 1-4 / A-D, with or without parens. Strip parens.
      const cleaned = candidate.replace(/[().]/g, "").trim();
      if (/^[1-4A-Da-d]$/.test(cleaned)) {
        await prisma.examQuestion.update({
          where: { id: r.id },
          data: { answer: cleaned },
        });
        reverted++;
      } else {
        skipped++;
        skippedDetails.push({ id: r.id, questionNum: r.questionNum, reason: candidate ? `couldn't normalise '${candidate}'` : "no Final answer line" });
      }
    }
    return NextResponse.json({ reverted, skipped, skippedDetails });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
