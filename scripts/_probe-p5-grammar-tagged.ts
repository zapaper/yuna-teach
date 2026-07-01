// Probe: at Primary 5 specifically, how many Grammar MCQ masters
// are subTopic-tagged? If the P5 pool is thin on tagged rows, the
// stratifier legitimately can't stratify.

import { prisma } from "@/lib/db";

async function main() {
  for (const level of ["Primary 4", "Primary 5", "Primary 6"]) {
    const rows = await prisma.examQuestion.findMany({
      where: {
        examPaper: {
          subject: { contains: "english", mode: "insensitive" },
          paperType: null,
          visible: true,
          level,
        },
        syllabusTopic: { contains: "grammar", mode: "insensitive" },
        NOT: [{ syllabusTopic: { contains: "cloze", mode: "insensitive" } }],
        sourceQuestionId: null,
      },
      select: { subTopic: true },
    });
    const tagged = rows.filter(q => q.subTopic).length;
    const byId = new Map<string, number>();
    for (const q of rows) {
      const k = q.subTopic ?? "(null)";
      byId.set(k, (byId.get(k) ?? 0) + 1);
    }
    console.log(`\n${level} Grammar MCQ masters: ${rows.length}, tagged: ${tagged}`);
    for (const [k, n] of [...byId.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n}  ${k}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
