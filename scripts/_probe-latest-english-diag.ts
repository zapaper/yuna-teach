// Probe: on the LATEST English diagnostic quiz created, do the
// clone questions carry subTopic? If not, the fluency query drops
// them. Answers the 'still no data' report.

import { prisma } from "@/lib/db";

async function main() {
  const paper = await prisma.examPaper.findFirst({
    where: {
      subject: "English Language",
      paperType: "quiz",
      metadata: { path: ["onboardingDiagnostic"], equals: true },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, createdAt: true, assignedToId: true, markingStatus: true },
  });
  console.log("Latest English diagnostic paper:", paper);
  if (!paper) return prisma.$disconnect();

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: paper.id },
    select: {
      id: true, questionNum: true, syllabusTopic: true, subTopic: true,
      marksAwarded: true, marksAvailable: true,
      sourceQuestionId: true,
    },
    orderBy: { orderIndex: "asc" },
  });
  console.log(`\nQuestions on paper: ${qs.length}`);
  let nullSubTopic = 0;
  for (const q of qs) {
    console.log(`Q${q.questionNum}  syllabusTopic=${q.syllabusTopic ?? "?"}  subTopic=${q.subTopic ?? "?"}  marks=${q.marksAwarded ?? "-"}/${q.marksAvailable ?? "-"}  sourceQ=${q.sourceQuestionId ?? "-"}`);
    if (!q.subTopic) nullSubTopic++;
  }
  console.log(`\nRows with null subTopic: ${nullSubTopic}/${qs.length}`);

  // Try the actual grammar-fluency query
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: paper.assignedToId!,
        subject: { contains: "english", mode: "insensitive" },
        markingStatus: { in: ["complete", "released"] },
        NOT: { paperType: "eval" },
      },
      syllabusTopic: { in: ["Grammar MCQ", "Grammar Cloze"] },
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
      subTopic: { not: null },
    },
    select: { subTopic: true, marksAwarded: true, marksAvailable: true },
  });
  console.log(`\nGrammar fluency query would return ${rows.length} rows`);
  const bySub = new Map<string, number>();
  for (const r of rows) bySub.set(r.subTopic!, (bySub.get(r.subTopic!) ?? 0) + 1);
  for (const [st, n] of bySub.entries()) console.log(`  ${n}  ${st}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
