import { prisma } from "../src/lib/db";

const STUDENT_ID = process.argv[2];
if (!STUDENT_ID) {
  console.error("Usage: npx tsx scripts/audit-revise-mistakes.ts <studentId>");
  process.exit(1);
}

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: STUDENT_ID, completedAt: { not: null } },
    orderBy: { completedAt: "desc" },
    take: 100,
    select: {
      id: true, title: true, subject: true, completedAt: true,
      questions: {
        select: {
          id: true, questionNum: true, marksAwarded: true, marksAvailable: true,
          syllabusTopic: true, sourceQuestionId: true,
          transcribedOptions: true, transcribedOptionImages: true, answer: true,
        },
      },
    },
  });
  console.log(`Scanned ${papers.length} completed papers\n`);

  function isMcq(opts: unknown, optImgs: unknown, answer: string | null): boolean {
    if (Array.isArray(opts) && opts.length === 4) return true;
    if (Array.isArray(optImgs) && optImgs.some((o) => !!o)) return true;
    const a = (answer ?? "").trim().replace(/[().]/g, "");
    return a === "1" || a === "2" || a === "3" || a === "4";
  }
  function classify(s: string | null): "math" | "science" | "english" | "other" {
    const lower = (s ?? "").toLowerCase();
    if (lower.includes("math")) return "math";
    if (lower.includes("science")) return "science";
    if (lower.includes("english")) return "english";
    return "other";
  }

  const stats: Record<string, { mistakes: number; mcq: number; oeq: number; noSourceId: number; partial: number; full0: number }> = {
    math: { mistakes: 0, mcq: 0, oeq: 0, noSourceId: 0, partial: 0, full0: 0 },
    science: { mistakes: 0, mcq: 0, oeq: 0, noSourceId: 0, partial: 0, full0: 0 },
    english: { mistakes: 0, mcq: 0, oeq: 0, noSourceId: 0, partial: 0, full0: 0 },
  };
  const englishTopics: Map<string, number> = new Map();

  for (const p of papers) {
    const subj = classify(p.subject);
    if (subj === "other") continue;
    for (const q of p.questions) {
      if (q.marksAwarded == null || q.marksAvailable == null) continue;
      if (q.marksAwarded >= q.marksAvailable) continue;
      const mcq = isMcq(q.transcribedOptions, q.transcribedOptionImages, q.answer);
      const s = stats[subj];
      s.mistakes++;
      if (mcq) s.mcq++; else s.oeq++;
      if (!q.sourceQuestionId) s.noSourceId++;
      if (q.marksAwarded === 0) s.full0++; else s.partial++;
      if (subj === "english") {
        const topic = q.syllabusTopic ?? "(untagged)";
        englishTopics.set(topic, (englishTopics.get(topic) ?? 0) + 1);
      }
    }
  }
  for (const subj of ["math", "science", "english"] as const) {
    const s = stats[subj];
    console.log(`${subj.toUpperCase()}: ${s.mistakes} mistakes  (mcq=${s.mcq}  oeq=${s.oeq})  full-0=${s.full0}  partial=${s.partial}  noSourceId=${s.noSourceId}`);
  }
  console.log("\nEnglish topic breakdown:");
  for (const [topic, n] of [...englishTopics.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(3)}  ${topic}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
