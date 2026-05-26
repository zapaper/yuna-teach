import { prisma } from "../src/lib/db";

const PAPER_ID = process.argv[2] ?? "cmpna5eon0001rh99weeor0gu";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: {
      id: true, title: true, subject: true, level: true,
      metadata: true,
      _count: { select: { questions: true } },
    },
  });
  if (!paper) {
    console.log("Not found");
    return;
  }
  console.log(`[${paper.subject} ${paper.level}] ${paper.title}`);
  console.log(`Questions: ${paper._count.questions}`);

  const md = paper.metadata as Record<string, unknown> | null;
  console.log("\nMetadata keys:", md ? Object.keys(md).join(", ") : "(none)");

  // Look for structure analysis info
  console.log("\nPapers (from metadata.papers):");
  console.log(JSON.stringify(md?.papers, null, 2));

  // Check what marks the questions actually got
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: { questionNum: true, marksAvailable: true, syllabusTopic: true },
    orderBy: { orderIndex: "asc" },
    take: 35,
  });
  console.log(`\nFirst ${qs.length} questions:`);
  for (const q of qs) {
    console.log(`  Q${q.questionNum.padEnd(5)} marks=${String(q.marksAvailable ?? "null").padEnd(5)} topic=${q.syllabusTopic ?? "—"}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
