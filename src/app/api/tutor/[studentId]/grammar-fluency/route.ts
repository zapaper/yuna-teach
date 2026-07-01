// GET /api/tutor/[studentId]/grammar-fluency
// Returns per-sub-topic accuracy for English Grammar (MCQ + Cloze
// combined) AND Synthesis & Transformation, so the tutor page can
// render side-by-side radar charts.
//
// Response shape:
//   { grammar: { subTopics: [{id,label,awarded,available,pct}], overall },
//     synthesis: { subTopics: [...], overall } }

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthorizedForStudent } from "@/lib/access";

// Labels use `\n` to control line breaks in the radar axis text —
// otherwise the SVG render splits on spaces and 'Connectors & tenses'
// spreads over 3 lines instead of 2.
const GRAMMAR_SUBTOPICS: Array<{ id: string; label: string }> = [
  { id: "connectors-tenses",       label: "Connectors &\ntenses" },
  { id: "verb-forms",              label: "Verb forms" },
  { id: "idiomatic-prepositions",  label: "Prepositions" },
  { id: "tag-questions",           label: "Tag questions" },
  { id: "countable/uncountable",   label: "Countable /\nuncountable" },
  { id: "subject-verb-agreement",  label: "Subject-verb\nagreement" },
  { id: "pronouns",                label: "Pronouns" },
];

const SYNTHESIS_SUBTOPICS: Array<{ id: string; label: string }> = [
  { id: "reported-speech",         label: "Reported speech" },
  { id: "correlative-preference",  label: "Correlative /\npreference" },
  { id: "subordinator",            label: "Subordinator" },
  { id: "participle-clauses",      label: "Participle clauses" },
  { id: "substitution-inversion",  label: "Substitution /\ninversion" },
  { id: "noun-phrase",             label: "Noun phrase" },
];

async function fluencyFor(studentId: string, syllabusTopics: string[], buckets: typeof GRAMMAR_SUBTOPICS) {
  // Match the student-progress endpoint filter exactly — exclude
  // eval paperType + revision-mode papers. Without these, revision
  // clones (curated past-mistake re-attempts) inflate the denominator
  // and pull the radar % below what the parent dashboard chart shows.
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: studentId,
        subject: { contains: "english", mode: "insensitive" },
        markingStatus: { in: ["complete", "released"] },
        NOT: { paperType: "eval" },
      },
      syllabusTopic: { in: syllabusTopics },
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
      subTopic: { not: null },
    },
    select: { subTopic: true, marksAwarded: true, marksAvailable: true, examPaper: { select: { metadata: true } } },
  });
  // `questions` is the row count (one row = one attempted question);
  // `available` is the sum of marks available (a 2-mark question
  // contributes 2). The table shows n=questions so parents read the
  // familiar "how many questions attempted" number instead of the
  // marks-denominator that inflates on 2-mark items.
  const byId = new Map<string, { awarded: number; available: number; questions: number }>();
  for (const r of rows) {
    const meta = (r.examPaper.metadata ?? {}) as { revisionMode?: string };
    if (meta.revisionMode) continue;
    if (!r.subTopic) continue;
    const cur = byId.get(r.subTopic) ?? { awarded: 0, available: 0, questions: 0 };
    cur.awarded += r.marksAwarded ?? 0;
    cur.available += r.marksAvailable ?? 0;
    cur.questions += 1;
    byId.set(r.subTopic, cur);
  }
  const subTopics = buckets.map(s => {
    const cur = byId.get(s.id) ?? { awarded: 0, available: 0, questions: 0 };
    const pct = cur.available > 0 ? Math.round(cur.awarded / cur.available * 100) : null;
    return { id: s.id, label: s.label, awarded: cur.awarded, available: cur.available, questions: cur.questions, pct };
  });
  const totalAwarded = subTopics.reduce((s, x) => s + x.awarded, 0);
  const totalAvailable = subTopics.reduce((s, x) => s + x.available, 0);
  const overall = totalAvailable > 0 ? Math.round(totalAwarded / totalAvailable * 100) : null;
  return { subTopics, totalAwarded, totalAvailable, overall };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const { studentId } = await params;
  const auth = await isAuthorizedForStudent(studentId);
  if (!auth.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [grammar, synthesis] = await Promise.all([
    fluencyFor(studentId, ["Grammar MCQ", "Grammar Cloze"], GRAMMAR_SUBTOPICS),
    fluencyFor(studentId, ["Synthesis / Transformation", "Synthesis & Transformation"], SYNTHESIS_SUBTOPICS),
  ]);
  return NextResponse.json({ grammar, synthesis });
}
