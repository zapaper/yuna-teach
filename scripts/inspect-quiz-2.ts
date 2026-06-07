import { prisma } from "../src/lib/db";
(async () => {
  for (const id of ["cmpgd6tzc002h10h2se9zdyfn", "cmpgdr0hp000112rz2qwpmhyh"]) {
    const p = await prisma.examPaper.findUnique({
      where: { id },
      select: {
        id: true, title: true, subject: true, paperType: true, examType: true,
        questions: {
          select: { id: true, questionNum: true, syllabusTopic: true, marksAvailable: true, transcribedSubparts: true, transcribedStem: true },
          orderBy: { orderIndex: "asc" },
        },
      },
    });
    if (!p) { console.log(`${id} — not found in local DB (likely prod-only)\n`); continue; }
    console.log(`${id}: ${p.title}  subject=${p.subject}  paperType=${p.paperType}  examType=${p.examType}  qs=${p.questions.length}`);
    for (const q of p.questions) {
      const subs = Array.isArray(q.transcribedSubparts) ? (q.transcribedSubparts as Array<{label?:string;diagramBase64?:string|null}>) : [];
      const drawable = subs.some(s => s.label === "_drawable" || s.diagramBase64);
      console.log(`  Q${q.questionNum} ${q.syllabusTopic ?? ""} marks=${q.marksAvailable} subparts=${subs.length}${subs.length ? " ("+subs.map(s=>s.label).join(",")+")" : ""} drawable=${drawable}`);
    }
    console.log();
  }
  await prisma.$disconnect();
})();
