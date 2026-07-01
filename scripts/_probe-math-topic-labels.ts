// Quick probe: what exact syllabusTopic strings does the Math MCQ
// pool use? We want to confirm the top-5 constants in
// api/daily-quiz/route.ts match the DB labels case-for-case.

import { prisma } from "@/lib/db";

async function main() {
  const rows = await prisma.examQuestion.groupBy({
    by: ["syllabusTopic"],
    where: {
      examPaper: {
        subject: { contains: "math", mode: "insensitive" },
        level: "Primary 6",
      },
      syllabusTopic: { not: null },
      sourceQuestionId: null,
      NOT: [
        { examPaper: { paperType: "eval" } },
      ],
    },
    _count: { _all: true },
  });
  const sorted = rows.sort((a, b) => (b._count._all as number) - (a._count._all as number));
  console.log("Math master-paper syllabusTopic distribution:");
  for (const r of sorted) {
    console.log(`  ${r._count._all}  '${r.syllabusTopic ?? "(null)"}'`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
