import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guard";

// Returns every question whose AI elaboration contains an aiKeyChallenge
// flag — the AI thought the official answer key was wrong. Reads the
// flag inline from the elaboration JSON (no separate column). Filters
// out the error sentinels.
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Postgres LIKE on the elaboration JSON string — cheap because we
  // only carry a few hundred rows here. Substring match guards against
  // both ' " ' encoding and field name typos.
  const candidates = await prisma.examQuestion.findMany({
    where: { elaboration: { contains: "aiKeyChallenge" } },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      elaboration: true,
      syllabusTopic: true,
      examPaper: { select: { id: true, title: true, level: true } },
    },
    orderBy: { id: "desc" },
  });

  const rows = candidates.map((q) => {
    let aiKeyChallenge: { suspectedWrong?: boolean; suggestedAnswer?: string; reason?: string } | null = null;
    let solution: string | null = null;
    try {
      const parsed = JSON.parse(q.elaboration ?? "{}") as { aiKeyChallenge?: typeof aiKeyChallenge; solution?: string };
      aiKeyChallenge = parsed.aiKeyChallenge ?? null;
      solution = parsed.solution ?? null;
    } catch { /* skip */ }
    return {
      id: q.id,
      questionNum: q.questionNum,
      stem: q.transcribedStem,
      options: q.transcribedOptions,
      answerKey: q.answer,
      syllabusTopic: q.syllabusTopic,
      paperId: q.examPaper.id,
      paperTitle: q.examPaper.title,
      paperLevel: q.examPaper.level,
      aiKeyChallenge,
      solution,
    };
  })
  // Drop any rows where the elaboration mentioned the field but didn't actually carry an object.
  .filter((r) => r.aiKeyChallenge !== null);

  return NextResponse.json(rows);
}
