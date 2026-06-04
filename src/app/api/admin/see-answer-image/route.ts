// Admin: list every question whose stored answer is "see answer image"
// (or close variants) so the answer text can be supplemented with a
// description for the AI marker. Read-only sweep — heavy lifting is
// on the client (rendering + filtering).
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// Matches the marker's see-image regex (lib/marking.ts) plus inline
// "(a) see answer image" / "refer to figure" variants.
const EXACT = /^\s*(?:see|refer to)\s+(?:answer\s+)?(?:image|diagram|figure|drawing|picture)\b.*$/i;
const INLINE = /\b(?:see|refer to)\s+(?:answer\s+)?(?:image|diagram|figure|drawing|picture)\b/i;

export async function GET(_request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  // Pull masters only — quiz / focused / mastery clones inherit from
  // the master row so cleaning the master is all we need.
  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null, paperType: null },
    select: {
      id: true,
      title: true,
      subject: true,
      year: true,
      createdAt: true,
      questions: {
        select: {
          id: true,
          questionNum: true,
          answer: true,
          answerImageData: true,
          syllabusTopic: true,
          marksAvailable: true,
        },
        orderBy: { orderIndex: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  type Q = {
    id: string;
    questionNum: string;
    answer: string;
    hasImage: boolean;
    topic: string | null;
    marks: number | null;
    matchType: "exact" | "inline";
  };
  type P = {
    id: string;
    title: string;
    subject: string | null;
    year: string | null;
    createdAt: string;
    isPsle: boolean;
    questionCount: number;
    questions: Q[];
  };

  const out: P[] = [];
  for (const p of papers) {
    const flagged: Q[] = [];
    for (const q of p.questions) {
      const ans = (q.answer ?? "").trim();
      if (!ans) continue;
      const exact = EXACT.test(ans);
      const inline = !exact && INLINE.test(ans);
      if (!exact && !inline) continue;
      flagged.push({
        id: q.id,
        questionNum: q.questionNum,
        answer: ans,
        hasImage: !!q.answerImageData,
        topic: q.syllabusTopic,
        marks: q.marksAvailable,
        matchType: exact ? "exact" : "inline",
      });
    }
    if (flagged.length === 0) continue;
    out.push({
      id: p.id,
      title: p.title,
      subject: p.subject,
      year: p.year,
      createdAt: p.createdAt.toISOString(),
      isPsle: /psle/i.test(p.title),
      questionCount: p.questions.length,
      questions: flagged,
    });
  }

  return NextResponse.json({
    papers: out,
    totalPapers: out.length,
    totalQuestions: out.reduce((s, p) => s + p.questions.length, 0),
  });
}
