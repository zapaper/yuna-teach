// GET /api/tutor/[studentId]/grammar-fluency
// Returns per-sub-topic accuracy for English Grammar (MCQ + Cloze
// combined) so the tutor page can render a radar chart. 7 fixed
// buckets matching the PSLE Grammar 7-rule classifier.
//
// Response shape:
//   { subTopics: [{ id, label, awarded, available, pct }] }
//
// Out of scope: gating on which kids see the chart — that's done UI-
// side. This endpoint is cheap so calling it for any kid is fine.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthorizedForStudent } from "@/lib/access";

const SUBTOPICS: Array<{ id: string; label: string }> = [
  { id: "connectors-tenses",       label: "Connectors & tenses" },
  { id: "verb-forms",              label: "Verb forms" },
  { id: "idiomatic-prepositions",  label: "Idiomatic prepositions" },
  { id: "tag-questions",           label: "Tag questions" },
  { id: "countable/uncountable",   label: "Countable / uncountable" },
  { id: "subject-verb-agreement",  label: "Subject-verb agreement" },
  { id: "pronouns",                label: "Pronouns" },
];

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const { studentId } = await params;
  const auth = await isAuthorizedForStudent(studentId);
  if (!auth.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: studentId,
        subject: { contains: "english", mode: "insensitive" },
        markingStatus: { in: ["complete", "released"] },
      },
      syllabusTopic: { in: ["Grammar MCQ", "Grammar Cloze"] },
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
      subTopic: { not: null },
    },
    select: { subTopic: true, marksAwarded: true, marksAvailable: true },
  });
  const byId = new Map<string, { awarded: number; available: number }>();
  for (const r of rows) {
    if (!r.subTopic) continue;
    const cur = byId.get(r.subTopic) ?? { awarded: 0, available: 0 };
    cur.awarded += r.marksAwarded ?? 0;
    cur.available += r.marksAvailable ?? 0;
    byId.set(r.subTopic, cur);
  }
  const out = SUBTOPICS.map(s => {
    const cur = byId.get(s.id) ?? { awarded: 0, available: 0 };
    const pct = cur.available > 0 ? Math.round(cur.awarded / cur.available * 100) : null;
    return { id: s.id, label: s.label, awarded: cur.awarded, available: cur.available, pct };
  });
  // total across all 7 for the overall display
  const totalAwarded = out.reduce((s, x) => s + x.awarded, 0);
  const totalAvailable = out.reduce((s, x) => s + x.available, 0);
  const overall = totalAvailable > 0 ? Math.round(totalAwarded / totalAvailable * 100) : null;
  return NextResponse.json({ subTopics: out, totalAwarded, totalAvailable, overall });
}
