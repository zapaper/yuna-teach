// Audit: are there P6 Science WA2 OEQ questions with a transcribed stem
// that we can seed synthetic OEQ generation from?
//
// Run: npx tsx scripts/audit-science-oeq-sources.ts

import { prisma } from "@/lib/db";

async function main() {
  const allScience = await prisma.examPaper.findMany({
    where: { subject: "Science", paperType: null, sourceExamId: null },
    select: { id: true, title: true, school: true, level: true, examType: true },
    orderBy: [{ level: "asc" }, { examType: "asc" }],
  });
  console.log(`all master Science papers: ${allScience.length}`);
  const byKey = new Map<string, number>();
  for (const p of allScience) {
    const key = `${p.level ?? "?"} / ${p.examType ?? "?"}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  console.log("\nbreakdown by level / examType:");
  for (const [k, v] of [...byKey].sort()) console.log(`  ${k}: ${v}`);

  const papers = allScience.filter((p) => p.level === "Primary 6" && p.examType === "WA2");
  console.log(`\nP6 Science WA2 papers: ${papers.length}`);
  for (const p of papers) console.log(`  ${p.id}  ${p.school ?? "—"}  ${p.title}`);

  if (papers.length === 0) {
    console.log("\nSample 5 Science paper rows to check title/examType consistency:");
    for (const p of allScience.slice(0, 5)) console.log(`  ${p.level}/${p.examType}  "${p.title}"  ${p.school ?? "—"}`);
    return;
  }

  const paperIds = papers.map((p) => p.id);
  const all = await prisma.examQuestion.findMany({
    where: { examPaperId: { in: paperIds } },
    select: {
      id: true,
      examPaperId: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedSubparts: true,
      marksAvailable: true,
      syllabusTopic: true,
      answer: true,
    },
  });
  console.log(`\nTotal questions in these 7 papers: ${all.length}`);
  const hasOptions = all.filter((q) => Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length > 0);
  const hasStemNoOptions = all.filter((q) => q.transcribedStem && !(Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length > 0));
  const hasSubparts = all.filter((q) => Array.isArray(q.transcribedSubparts) && (q.transcribedSubparts as unknown[]).length > 0);
  console.log(`  MCQ (transcribedOptions non-empty): ${hasOptions.length}`);
  console.log(`  non-MCQ with stem: ${hasStemNoOptions.length}`);
  console.log(`  any subparts: ${hasSubparts.length}`);
  console.log(`  neither stem nor options: ${all.filter((q) => !q.transcribedStem && !(Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length)).length}`);

  const qs = hasStemNoOptions;
  console.log(`\nOEQ with stem: ${qs.length}`);
  const withSubparts = qs.filter((q) => Array.isArray(q.transcribedSubparts) && (q.transcribedSubparts as unknown[]).length > 0);
  console.log(`  with subparts: ${withSubparts.length}`);
  console.log(`  single-stem:   ${qs.length - withSubparts.length}`);

  // Distribution by marksAvailable
  const byMarks = new Map<string, number>();
  for (const q of qs) {
    const key = q.marksAvailable == null ? "null" : String(q.marksAvailable);
    byMarks.set(key, (byMarks.get(key) ?? 0) + 1);
  }
  console.log("\nmarksAvailable distribution:");
  for (const [k, v] of [...byMarks].sort()) console.log(`  ${k}: ${v}`);

  console.log("\nsample with subparts (genuine OEQ):");
  for (const q of hasSubparts.slice(0, 3)) {
    console.log("---");
    console.log(`q${q.questionNum}  (${q.marksAvailable ?? "?"}m)  topic=${q.syllabusTopic ?? "—"}`);
    console.log(`stem: ${q.transcribedStem?.slice(0, 250)}`);
    console.log(`subparts: ${JSON.stringify(q.transcribedSubparts).slice(0, 500)}`);
    console.log(`answer: ${q.answer?.slice(0, 300)}`);
  }
}

main().finally(() => prisma.$disconnect());
