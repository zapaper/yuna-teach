import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

const isMcqAnswer = (a: string | null | undefined) => ["1","2","3","4"].includes((a ?? "").replace(/[().]/g, "").trim());
const isSubpartNum = (qn: string) => /[a-z]+/i.test(qn ?? "");
const isPassageBound = (topic: string | null | undefined) => {
  const x = (topic ?? "").toLowerCase();
  return (x.includes("grammar") && x.includes("cloze")) || x.includes("editing") || (x.includes("comprehension") && x.includes("cloze"));
};

// GET /api/admin/broken-questions
// Returns questions with missing stems / missing answers / (optional) missing MCQ options,
// across all visible master papers, so admin can fix them one by one.
export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const qs = await prisma.examQuestion.findMany({
    where: { examPaper: { sourceExamId: null, paperType: null, visible: true } },
    select: {
      id: true, questionNum: true, transcribedStem: true, transcribedOptions: true, transcribedOptionImages: true,
      transcribedSubparts: true, answer: true, diagramImageData: true, imageData: true, syllabusTopic: true, orderIndex: true,
      examPaper: { select: { id: true, title: true, subject: true } },
    },
    orderBy: [{ examPaperId: "asc" }, { orderIndex: "asc" }],
  });

  type Reason = "missing_stem" | "missing_answer" | "synthesis_no_source" | "mcq_no_options";
  const items: Array<{
    id: string; questionNum: string; paperId: string; paperTitle: string; subject: string | null;
    stem: string | null; answer: string | null; options: string[] | null; reasons: Reason[];
    imageData: string; topic: string | null;
  }> = [];

  for (const q of qs) {
    const stem = (q.transcribedStem ?? "").trim();
    const reasons: Reason[] = [];

    if (!q.answer || !q.answer.trim()) reasons.push("missing_answer");

    if (!isPassageBound(q.syllabusTopic) && !isSubpartNum(q.questionNum) && !stem && !q.diagramImageData) {
      reasons.push("missing_stem");
    }

    // Synthesis: stem must have source sentence before **bold**
    if ((q.syllabusTopic ?? "").toLowerCase().includes("synthesis") && stem) {
      const idx = stem.indexOf("**");
      if (idx >= 0) {
        const before = stem.slice(0, idx).trim();
        if (before.length < 15 || /^[_\s]*$/.test(before)) reasons.push("synthesis_no_source");
      }
    }

    if (reasons.length === 0) continue;

    items.push({
      id: q.id,
      questionNum: q.questionNum,
      paperId: q.examPaper.id,
      paperTitle: q.examPaper.title,
      subject: q.examPaper.subject,
      stem: q.transcribedStem,
      answer: q.answer,
      options: (q.transcribedOptions as string[] | null) ?? null,
      imageData: q.imageData,
      topic: q.syllabusTopic,
      reasons,
    });
  }

  return NextResponse.json({ total: items.length, items });
}
