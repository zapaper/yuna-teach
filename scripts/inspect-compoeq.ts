import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = "cmp6ijbap000110efptud2hlm";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, subject: true, sourceExamId: true, metadata: true },
  });
  if (!paper) return console.log("not found");
  console.log("Paper:", paper.title, paper.subject, "sourceExamId:", paper.sourceExamId);

  // Find all OEQ-ish questions
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, syllabusTopic: { contains: "ompre" } },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, syllabusTopic: true,
      transcribedStem: true, transcribedOptions: true,
      answer: true, marksAvailable: true,
      sourceQuestionId: true,
    },
  });

  // Find source masters of the comp OEQ questions
  const compOeqSourceIds = [...new Set(qs.filter(q => {
    const t = (q.syllabusTopic ?? "").toLowerCase();
    return t.includes("comprehension") && (t.includes("open") || t.includes("oe") || t.includes("oeq"));
  }).map(q => q.sourceQuestionId).filter((x): x is string => !!x))];
  if (compOeqSourceIds.length > 0) {
    const sources = await prisma.examQuestion.findMany({ where: { id: { in: compOeqSourceIds } }, select: { id: true, examPaperId: true, examPaper: { select: { id: true, title: true, metadata: true } } } });
    const uniquePapers = new Map<string, { title: string; metadata: unknown }>();
    for (const s of sources) uniquePapers.set(s.examPaper.id, { title: s.examPaper.title, metadata: s.examPaper.metadata });
    console.log(`\nCompOEQ source masters:`);
    for (const [pId, info] of uniquePapers) {
      const meta = info.metadata as Record<string, unknown> | null;
      const ocr = meta?.sectionOcrTexts as Record<string, { ocrText?: string; passageOcrText?: string }> | undefined;
      console.log(`  ${pId} — ${info.title}`);
      if (ocr) {
        for (const [secName, secData] of Object.entries(ocr)) {
          const sl = secName.toLowerCase();
          if (sl.includes("comprehension") && (sl.includes("open") || sl.includes("oeq"))) {
            console.log(`    section "${secName}" — keys: ${Object.keys(secData).join(", ")}`);
            console.log(`    passageOcrText (first 600 chars):`);
            console.log(`    ${(secData.passageOcrText ?? "(none)").slice(0, 600).replace(/\n/g, "\n    ")}`);
          }
        }
      } else {
        console.log(`    (no sectionOcrTexts)`);
      }
    }
  }

  console.log(`\n${qs.length} comp questions:`);
  for (const q of qs) {
    console.log(`\n=== Q${q.questionNum} · ${q.syllabusTopic} · marks ${q.marksAvailable} ===`);
    console.log(`stem: ${q.transcribedStem?.slice(0, 400) ?? "(none)"}`);
    if (q.transcribedOptions) console.log(`options: ${JSON.stringify(q.transcribedOptions).slice(0, 200)}`);
    console.log(`answer: ${q.answer?.slice(0, 200) ?? "(none)"}`);
  }

  // Also check metadata.sectionOcrTexts for the OEQ passage
  const meta = paper.metadata as Record<string, unknown> | null;
  console.log("\nmetadata keys:", meta ? Object.keys(meta) : "(no metadata)");
  const sectionOcr = meta?.sectionOcrTexts as Record<string, { ocrText: string; passageOcrText?: string; passageOcrTextNumbered?: string }> | undefined;
  if (sectionOcr) {
    console.log(`\nSection OCR keys:`, Object.keys(sectionOcr));
    for (const [k, v] of Object.entries(sectionOcr)) {
      if (k.toLowerCase().includes("ompr") && k.toLowerCase().includes("open")) {
        console.log(`\n=== Comprehension OEQ OCR (${k}) ===`);
        console.log(`ocrText (first 1500):`);
        console.log(v.ocrText?.slice(0, 1500));
        if (v.passageOcrText) {
          console.log(`\npassageOcrText (first 1500):`);
          console.log(v.passageOcrText.slice(0, 1500));
        }
      }
    }
  } else {
    console.log("\nNo sectionOcrTexts in metadata");
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
