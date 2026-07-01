import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  for (const level of ["Primary 3", "Primary 4"]) {
    const rows = await prisma.examQuestion.findMany({
      where: {
        sourceQuestionId: null,
        examPaper: { paperType: null, sourceExamId: null, extractionStatus: "ready", level, subject: { contains: "english", mode: "insensitive" } },
      },
      select: { syllabusTopic: true, elaboration: true, transcribedOptions: true },
    });
    const mcq = rows.filter(r => Array.isArray(r.transcribedOptions) && r.transcribedOptions.length >= 2);
    const byTopic = new Map<string, { total: number; unfilled: number }>();
    for (const r of mcq) {
      const t = r.syllabusTopic ?? "(none)";
      const cur = byTopic.get(t) ?? { total: 0, unfilled: 0 };
      cur.total++;
      if ((r.elaboration ?? "").trim().length < 20) cur.unfilled++;
      byTopic.set(t, cur);
    }
    console.log(`\n${level} English MCQ by syllabusTopic:`);
    for (const [t, v] of [...byTopic.entries()].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${t.padEnd(30)}  total=${v.total.toString().padStart(3)}  unfilled=${v.unfilled.toString().padStart(3)}`);
    }
  }
  await prisma.$disconnect();
})();
