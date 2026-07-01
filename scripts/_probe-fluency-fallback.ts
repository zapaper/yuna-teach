// Run the EXACT grammar-fluency route logic (with the master-fallback)
// against a specific paper to see what the route would return.

import { prisma } from "@/lib/db";

const STUDENT_ID = "cmr27gcue0003cp5hhqbc6vje"; // the assignee of the latest English diag

const GRAMMAR_SUBTOPICS = [
  { id: "connectors-tenses", label: "Connectors" },
  { id: "verb-forms", label: "Verb forms" },
  { id: "idiomatic-prepositions", label: "Prepositions" },
  { id: "tag-questions", label: "Tag questions" },
  { id: "countable/uncountable", label: "Countable" },
  { id: "subject-verb-agreement", label: "SVA" },
  { id: "pronouns", label: "Pronouns" },
];

async function main() {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: STUDENT_ID,
        subject: { contains: "english", mode: "insensitive" },
        markingStatus: { in: ["complete", "released"] },
        NOT: { paperType: "eval" },
      },
      syllabusTopic: { in: ["Grammar MCQ", "Grammar Cloze"] },
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
    },
    select: {
      subTopic: true,
      sourceQuestionId: true,
      marksAwarded: true,
      marksAvailable: true,
    },
  });
  console.log(`Grammar rows (no subTopic filter): ${rows.length}`);
  for (const r of rows) {
    console.log(`  cloneSub=${r.subTopic ?? "null"}  sourceQ=${r.sourceQuestionId ?? "-"}  ${r.marksAwarded}/${r.marksAvailable}`);
  }

  const masterIdsNeeded = [...new Set(
    rows.filter(r => !r.subTopic && !!r.sourceQuestionId).map(r => r.sourceQuestionId as string)
  )];
  console.log(`\nMasters to lookup: ${masterIdsNeeded.length}`);
  const masters = await prisma.examQuestion.findMany({
    where: { id: { in: masterIdsNeeded } },
    select: { id: true, subTopic: true },
  });
  const masterSubMap = new Map<string, string | null>();
  for (const m of masters) masterSubMap.set(m.id, m.subTopic ?? null);

  console.log(`\nMaster subTopic backfill:`);
  const byId = new Map<string, { awarded: number; available: number; questions: number }>();
  for (const r of rows) {
    const effective = r.subTopic ?? (r.sourceQuestionId ? masterSubMap.get(r.sourceQuestionId) ?? null : null);
    console.log(`  clone=${r.subTopic ?? "null"} → master=${r.sourceQuestionId ? masterSubMap.get(r.sourceQuestionId) : "-"} → effective=${effective ?? "null"}`);
    if (!effective) continue;
    const cur = byId.get(effective) ?? { awarded: 0, available: 0, questions: 0 };
    cur.awarded += r.marksAwarded ?? 0;
    cur.available += r.marksAvailable ?? 0;
    cur.questions += 1;
    byId.set(effective, cur);
  }

  console.log(`\nFluency buckets after fallback:`);
  for (const bucket of GRAMMAR_SUBTOPICS) {
    const c = byId.get(bucket.id);
    if (!c) { console.log(`  ${bucket.id}: no data`); continue; }
    console.log(`  ${bucket.id}: n=${c.questions} awarded=${c.awarded} available=${c.available}`);
  }
  const allKeys = [...byId.keys()];
  const untracked = allKeys.filter(k => !GRAMMAR_SUBTOPICS.some(b => b.id === k));
  if (untracked.length > 0) {
    console.log(`\nEffective subTopics NOT in our 7-bucket list (route drops these):`);
    for (const k of untracked) console.log(`  ${k}: n=${byId.get(k)?.questions}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
