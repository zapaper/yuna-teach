import { prisma } from "../src/lib/db";

// Snapshot the elaboration column on every question that's gotten one
// recently — so we can tell whether the save is happening at all (and
// whether it's the JSON shape or legacy plain text).

async function main() {
  const rows = await prisma.examQuestion.findMany({
    where: { elaboration: { not: null } },
    select: {
      id: true,
      questionNum: true,
      elaboration: true,
      examPaper: { select: { id: true, title: true, paperType: true, sourceExamId: true, completedAt: true } },
    },
    orderBy: { id: "desc" },
    take: 20,
  });
  console.log(`${rows.length} most-recent questions with elaboration:\n`);
  for (const r of rows) {
    const len = r.elaboration?.length ?? 0;
    const isJson = r.elaboration?.trim().startsWith("{") ?? false;
    const tag = isJson ? "JSON" : "TEXT";
    const paperTag = r.examPaper.sourceExamId ? "clone" : "master";
    const completedTag = r.examPaper.completedAt ? "✓" : "·";
    console.log(`[${tag}] ${len.toString().padStart(5)} ch  Q${r.questionNum.padEnd(3)}  ${paperTag.padEnd(6)} ${completedTag}  ${r.examPaper.title}`);
  }
  console.log();

  // Also count the totals
  const total = await prisma.examQuestion.count({ where: { elaboration: { not: null } } });
  const totalAll = await prisma.examQuestion.count();
  console.log(`Overall: ${total} / ${totalAll} questions have an elaboration cached`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
