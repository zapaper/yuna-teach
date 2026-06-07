import { prisma } from "../src/lib/db";

function trim(s: string | null | undefined, n = 1500): string {
  if (!s) return "(none)";
  return s.length > n ? s.slice(0, n) + "…(truncated)" : s;
}

async function main() {
  // The eval clones into a new paper each run. Find the latest mastery
  // clone whose source is the PSLE Chinese 2025 paper.
  const SOURCE = "cmq0tgcuc00011e0qqv3pfcjc";
  const latestClone = await prisma.examPaper.findFirst({
    where: {
      title: { contains: "PSLE Chinese 2025", mode: "insensitive" },
      sourceExamId: SOURCE,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, createdAt: true, score: true, totalMarks: true },
  });
  console.log("Latest eval clone:", latestClone);

  if (!latestClone) { process.exit(1); }

  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: latestClone.id, questionNum: "40" },
    select: {
      id: true, questionNum: true,
      marksAvailable: true, marksAwarded: true,
      transcribedStem: true, transcribedSubparts: true,
      answer: true, studentAnswer: true,
      markingNotes: true, elaboration: true,
    },
  });
  if (!q) {
    // Try Q40 family (Q40a, Q40bc, etc.)
    const family = await prisma.examQuestion.findMany({
      where: { examPaperId: latestClone.id, questionNum: { startsWith: "40" } },
      select: { questionNum: true, marksAvailable: true, marksAwarded: true },
      orderBy: { questionNum: "asc" },
    });
    console.log("No exact Q40, family:", family);
    process.exit(0);
  }

  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log(`Q${q.questionNum} (${q.id}) — marks ${q.marksAwarded}/${q.marksAvailable}`);
  console.log("══════════════════════════════════════════════════════════════════════");

  console.log("\n>> STEM:");
  console.log(trim(q.transcribedStem, 2000));

  console.log("\n>> SUBPARTS:");
  const sps = q.transcribedSubparts as Array<Record<string, unknown>> | null;
  if (Array.isArray(sps) && sps.length > 0) {
    for (const sp of sps) {
      const label = String(sp.label ?? "");
      const text = String(sp.text ?? "");
      const ans = sp.answer ?? null;
      console.log(`  (${label}) ${trim(text, 600)}`);
      if (ans) console.log(`      answer: ${trim(String(ans), 500)}`);
    }
  } else {
    console.log("  (no subparts)");
  }

  console.log("\n>> ANSWER KEY:");
  console.log(trim(q.answer, 1500));

  console.log("\n>> STUDENT ANSWER:");
  console.log(trim(q.studentAnswer, 2000));

  console.log("\n>> MARKING NOTES:");
  console.log(trim(q.markingNotes, 3000));

  process.exit(0);
}
main();
