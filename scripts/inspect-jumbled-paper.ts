import { prisma } from "../src/lib/db";

(async () => {
  const id = "cmphofdc80001hqjexjvvngxt";
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      subject: true,
      pageCount: true,
      metadata: true,
      questions: {
        select: {
          questionNum: true,
          orderIndex: true,
          pageIndex: true,
          syllabusTopic: true,
          marksAvailable: true,
          answer: true,
          transcribedStem: true,
          transcribedOptions: true,
        },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) { console.log("Not found"); return; }
  console.log(`Paper: ${paper.title}  (${paper.pageCount} pages, subject=${paper.subject})`);

  const meta = paper.metadata as Record<string, unknown>;
  const cnSections = (meta?.chineseSections as Array<{ label: string; startIndex: number; endIndex: number; passagePageIndices?: number[] }>) ?? [];
  console.log("\nchineseSections (in metadata order):");
  for (const s of cnSections) {
    console.log(`  "${s.label}"  Q[${s.startIndex}..${s.endIndex}]  passagePages=${s.passagePageIndices?.join(",") ?? "—"}`);
  }

  const papers = (meta?.papers as Array<{ label: string; skipExtraction?: boolean; pageIndices?: number[] }>) ?? [];
  console.log("\npapers metadata:");
  for (const p of papers) {
    console.log(`  "${p.label}"  skipExtraction=${p.skipExtraction ?? false}  pages=${p.pageIndices?.join(",") ?? "—"}`);
  }

  console.log(`\nAll ${paper.questions.length} questions:`);
  for (const q of paper.questions) {
    const opts = q.transcribedOptions;
    const isMcq = Array.isArray(opts) && opts.length > 0;
    console.log(`  ord=${q.orderIndex}  Q${q.questionNum}  page=${q.pageIndex}  ${isMcq ? "MCQ" : "OEQ"}  topic="${q.syllabusTopic ?? "—"}"  ans=${q.answer ?? "—"}  marks=${q.marksAvailable ?? "?"}`);
  }
  await prisma.$disconnect();
})();
