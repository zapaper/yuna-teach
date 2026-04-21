import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { isSessionAdmin } from "@/lib/session";
import { generateContentWithRetry } from "@/lib/gemini";

// One-off admin tool: re-tag P4/P5 math questions currently labelled "Algebra"
// to a non-Algebra topic from the existing syllabus list. P4/P5 papers should
// not have Algebra questions — these are usually Fractions, Ratio, etc.

// Topic list = P6 math syllabus with Algebra removed. P4/P5 use a subset of
// the same labels; we don't have a separate P4/P5 list in the codebase.
const ALLOWED_TOPICS = [
  "Basic math operations",
  "Fractions",
  "Percentage",
  "Ratio",
  "Area and circumference of circle",
  "Volume of cube and cuboid",
  "Geometry",
  "Statistics",
  "Time",
  "Volume measurement",
] as const;

const P4_LEVELS = ["P4", "Primary 4", "4"];
const P5_LEVELS = ["P5", "Primary 5", "5"];
const TARGET_LEVELS = [...P4_LEVELS, ...P5_LEVELS];

function buildPrompt(stem: string, options: string[] | null): string {
  const optBlock = options && options.length > 0
    ? options.map((o, i) => `(${i + 1}) ${o}`).join("\n")
    : "(no options — OEQ)";
  return `You are re-classifying a Singapore Primary 4 or Primary 5 math question.
The previous classification was "Algebra", which is incorrect for this level.
P4/P5 questions are typically Fractions, Ratio, Percentage, Geometry, etc.

Choose EXACTLY ONE topic from this list (the list does NOT include Algebra):
${ALLOWED_TOPICS.map(t => `- ${t}`).join("\n")}

Question:
${stem}

Options:
${optBlock}

Return ONLY valid JSON:
{ "topic": "<one of the topics above>" }

Rules:
- Pick the topic that best matches the main concept tested.
- Do NOT return "Algebra".
- If the question involves fractions or mixed numbers, use "Fractions".
- If it involves ratios like 3:5, use "Ratio".
- If it involves % or percentages, use "Percentage".
- If it involves angles or shapes, use "Geometry".
- If it involves perimeter or area (non-circle), use "Basic math operations" only if arithmetic, otherwise closest fit.
- If it involves time (hours, minutes, duration), use "Time".
- If it involves data tables/graphs/averages, use "Statistics".`;
}

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const limit = Math.max(1, Math.min(100, Number(body.limit) || 20));
  const dryRun = body.dryRun === true;

  const where: Prisma.ExamQuestionWhereInput = {
    syllabusTopic: "Algebra",
    examPaper: {
      subject: { contains: "math", mode: "insensitive" },
      level: { in: TARGET_LEVELS },
    },
  };

  const total = await prisma.examQuestion.count({ where });
  const questions = await prisma.examQuestion.findMany({
    where,
    select: {
      id: true,
      transcribedStem: true,
      transcribedOptions: true,
      examPaper: { select: { id: true, title: true, level: true } },
    },
    orderBy: { id: "asc" },
    take: limit,
  });

  const results: Array<{ id: string; paperTitle: string; level: string | null; from: string; to: string | null; error?: string }> = [];

  for (const q of questions) {
    const stem = q.transcribedStem?.trim() || "";
    if (!stem) {
      results.push({ id: q.id, paperTitle: q.examPaper.title, level: q.examPaper.level, from: "Algebra", to: null, error: "no transcribed stem" });
      continue;
    }
    const opts = Array.isArray(q.transcribedOptions)
      ? (q.transcribedOptions as Prisma.JsonArray).filter((v): v is string => typeof v === "string")
      : null;
    try {
      const response = await generateContentWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: buildPrompt(stem, opts) }] }],
        config: { responseMimeType: "application/json", temperature: 0 },
      }, 2, 3000, "reclassify-algebra");
      const raw = (response.text ?? "{}").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(raw) as { topic?: string };
      const newTopic = typeof parsed.topic === "string" ? parsed.topic : null;
      if (!newTopic || !(ALLOWED_TOPICS as readonly string[]).includes(newTopic)) {
        results.push({ id: q.id, paperTitle: q.examPaper.title, level: q.examPaper.level, from: "Algebra", to: newTopic, error: "AI returned invalid topic" });
        continue;
      }
      if (!dryRun) {
        await prisma.examQuestion.update({ where: { id: q.id }, data: { syllabusTopic: newTopic } });
      }
      results.push({ id: q.id, paperTitle: q.examPaper.title, level: q.examPaper.level, from: "Algebra", to: newTopic });
    } catch (err) {
      results.push({
        id: q.id,
        paperTitle: q.examPaper.title,
        level: q.examPaper.level,
        from: "Algebra",
        to: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    totalRemaining: total,
    processed: results.length,
    dryRun,
    results,
  });
}
