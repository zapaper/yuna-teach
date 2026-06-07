// For each PSLE Chinese 语文应用 MCQ idiom in our top list, find which
// papers AND which question slots they appeared in. Detects true cross-
// year repeats vs the within-question 4-option inflation.

import { prisma } from "../src/lib/db";

const IDIOMS = [
  "目不转睛", "一言为定", "神机妙算", "异口同声", "恍然大悟",
  "垂头丧气", "左思右想", "不慌不忙", "五彩缤纷", "津津有味",
  "眉开眼笑", "手舞足蹈", "齐心协力", "获益不浅", "加油打气", "反败为胜",
];

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { level: { equals: "PSLE", mode: "insensitive" } },
      ],
      subject: { contains: "chinese", mode: "insensitive" },
      sourceExamId: null,
      paperType: null,
    },
    select: { id: true, year: true },
  });
  const paperById = new Map(papers.map(p => [p.id, p.year]));

  const questions = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: papers.map(p => p.id) },
      syllabusTopic: "语文应用 MCQ",
    },
    select: {
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      examPaperId: true,
    },
  });

  for (const idiom of IDIOMS) {
    const hits: Array<{ year: string; qNum: string; slot: string }> = [];
    for (const q of questions) {
      const stem = q.transcribedStem ?? "";
      const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as string[]) : [];
      const inStem = stem.includes(idiom);
      const inOpts = opts.some(o => (o ?? "").includes(idiom));
      if (!inStem && !inOpts) continue;
      const year = paperById.get(q.examPaperId) ?? "?";
      const slot = inStem && inOpts
        ? "stem+opts"   // shouldn't happen but flag
        : inStem
          ? "stem (Q7/Q8 meaning)"
          : "opts (Q13-15 usage)";
      hits.push({ year, qNum: q.questionNum ?? "?", slot });
    }
    if (hits.length === 0) continue;
    const distinctYears = new Set(hits.map(h => h.year));
    const repeatTag = distinctYears.size >= 2 ? "  ⭐ REPEAT" : "";
    console.log(`\n${idiom}  (${hits.length} question(s), ${distinctYears.size} year(s))${repeatTag}`);
    for (const h of hits) {
      console.log(`    ${h.year}  Q${h.qNum}  ${h.slot}`);
    }
  }

  await prisma.$disconnect();
})();
