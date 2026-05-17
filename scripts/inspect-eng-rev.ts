import { prisma } from "../src/lib/db";

(async () => {
  const ID = process.argv[2];
  if (!ID) {
    // List recent english revision papers if no id given
    const recent = await prisma.examPaper.findMany({
      where: { paperType: "quiz", subject: { contains: "english", mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, title: true, createdAt: true, metadata: true },
    });
    for (const p of recent) {
      const meta = p.metadata as { revisionMode?: string } | null;
      if (!meta?.revisionMode) continue;
      console.log(`${p.id}  ${p.createdAt.toISOString().slice(0,16)}  ${p.title}`);
    }
    process.exit(0);
  }
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { id: true, title: true, createdAt: true, metadata: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: { questionNum: true, orderIndex: true, syllabusTopic: true, marksAwarded: true, marksAvailable: true, studentAnswer: true, answer: true, sourceQuestionId: true },
      },
    },
  });
  if (!p) { console.error("not found"); process.exit(1); }
  console.log(`=== ${p.id}  ${p.title}`);
  const meta = p.metadata as Record<string, unknown> | null;
  const sections = meta?.englishSections as Array<{label:string;startIndex:number;endIndex:number;passage?:string}> | undefined;
  if (sections) {
    for (const s of sections) {
      const markers = s.passage ? [...s.passage.matchAll(/\*\*\((\d+)\)/g)].map(m => m[1]) : [];
      console.log(`\n  Section [${s.startIndex}-${s.endIndex}]  "${s.label}"`);
      console.log(`    passage: ${s.passage ? `${s.passage.length}ch  markers=[${markers.join(",")}]` : "MISSING"}`);
      const secQs = p.questions.slice(s.startIndex, s.endIndex + 1);
      console.log(`    questions in section: ${secQs.length}`);
      for (const q of secQs) {
        const ans = (q.studentAnswer ?? "").slice(0, 30);
        const key = (q.answer ?? "").slice(0, 30);
        console.log(`      Q${q.questionNum}  idx=${q.orderIndex}  ${q.marksAwarded}/${q.marksAvailable}  studentAns="${ans}"  key="${key}"`);
      }
    }
  } else {
    console.log("  NO englishSections metadata");
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
