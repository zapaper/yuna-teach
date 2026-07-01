import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "english", mode: "insensitive" },
      OR: [
        { title: { contains: "2014", mode: "insensitive" } },
        { year: "2014" },
      ],
    },
    select: {
      id: true, title: true, level: true, year: true, examType: true,
      paperType: true, sourceExamId: true, extractionStatus: true,
      _count: { select: { questions: true } },
    },
    orderBy: { title: "asc" },
  });
  console.log(`English + 2014 papers: ${papers.length}\n`);
  const seen = new Set<string>();
  for (const p of papers) {
    const key = `${p.title}|${p.year}|${p.level}|${p.paperType}|${p.sourceExamId ?? ""}|${p.examType ?? ""}`;
    if (seen.has(key) && (p.paperType === "quiz" || p.paperType === "focused")) continue;
    seen.add(key);
    console.log(`  ${(p.paperType ?? "master").padEnd(8)}  L=${(p.level ?? "?").padEnd(12)}  y=${p.year ?? "?"}  ext=${(p.extractionStatus ?? "?").padEnd(7)}  qs=${p._count.questions.toString().padStart(3)}  → ${p.title.slice(0, 60)}`);
  }

  // Now narrow to what looks like a real PSLE 2014 master paper
  const psle2014 = papers.filter(p =>
    p.paperType === null &&
    p.sourceExamId === null &&
    (p.year === "2014" || /2014/.test(p.title)) &&
    (p.level === "PSLE" || /psle/i.test(p.title))
  );
  console.log(`\nMaster PSLE 2014 English candidates: ${psle2014.length}`);
  for (const p of psle2014) {
    console.log(`  ${p.id}  qs=${p._count.questions}  ext=${p.extractionStatus}  → ${p.title}`);
  }

  // For each master, count Grammar MCQ questions
  for (const p of psle2014) {
    const grammarMcq = await prisma.examQuestion.count({
      where: {
        examPaperId: p.id,
        syllabusTopic: "Grammar MCQ",
      },
    });
    // Also count all questions to show scale
    const total = await prisma.examQuestion.count({ where: { examPaperId: p.id } });
    console.log(`\n${p.title} (${p.id}):`);
    console.log(`  Grammar MCQ count: ${grammarMcq}`);
    console.log(`  Total questions:   ${total}`);
    // Also show the Grammar MCQ question numbers
    const rows = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, syllabusTopic: "Grammar MCQ" },
      orderBy: [{ orderIndex: "asc" }],
      select: { questionNum: true, transcribedOptions: true, transcribedStem: true },
    });
    console.log(`  Grammar MCQ question numbers: ${rows.map(r => r.questionNum).join(", ")}`);
    // And what other MCQ types exist in this paper
    const byTopic = await prisma.examQuestion.groupBy({
      by: ["syllabusTopic"],
      where: { examPaperId: p.id },
      _count: { _all: true },
    });
    console.log(`  Breakdown by syllabusTopic:`);
    for (const t of byTopic) console.log(`    ${(t.syllabusTopic ?? "(none)").padEnd(30)}  ${t._count._all}`);
  }
  await prisma.$disconnect();
})();
