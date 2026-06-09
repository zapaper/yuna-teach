// Inspect Q2 on the user-referenced paper to confirm what got sent
// to the elaborate prompt vs. what was hallucinated.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_probe-q2-elab.ts

import { prisma } from "../src/lib/db";

(async () => {
  const PAPER = "cmq63oni3006reykwi6cshgzq";
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, title: true, subject: true, paperType: true, sourceExamId: true },
  });
  console.log(`paper="${p?.title}" subj=${p?.subject} type=${p?.paperType} source=${p?.sourceExamId ?? "(master)"}`);

  // Inspect both the clone (URL paper) and master if it's a clone.
  for (const queryPaper of [PAPER, ...(p?.sourceExamId ? [p.sourceExamId] : [])]) {
    console.log(`\n========== paperId=${queryPaper} ==========`);
    const q = await prisma.examQuestion.findFirst({
      where: { examPaperId: queryPaper, questionNum: "2" },
      select: {
        id: true,
        questionNum: true,
        answer: true,
        syllabusTopic: true,
        transcribedStem: true,
        transcribedOptions: true,
        sourceQuestionId: true,
        // Image presence (not the bytes — just whether they exist + how big).
        imageData: true,
        diagramImageData: true,
        elaboration: true,
      },
    });
    if (!q) {
      console.log(`  Q2 not found on ${queryPaper}`);
      continue;
    }
    console.log(`--- Q2 (id=${q.id}) ---`);
    console.log(`  topic: ${q.syllabusTopic ?? "(none)"}`);
    console.log(`  answer key: ${q.answer ?? "(none)"}`);
    console.log(`  stem (first 200 chars): ${(q.transcribedStem ?? "(none)").slice(0, 200)}`);
    const opts = q.transcribedOptions as string[] | null;
    if (opts) console.log(`  options: ${opts.map((o, i) => `(${i + 1}) ${o}`).join(" | ")}`);
    console.log(`  imageData: ${q.imageData ? `${q.imageData.length} chars (~${Math.round(q.imageData.length / 1024)} KB base64)` : "(MISSING)"}`);
    console.log(`  diagramImageData: ${q.diagramImageData ? `${q.diagramImageData.length} chars (~${Math.round(q.diagramImageData.length / 1024)} KB base64)` : "(MISSING)"}`);
    console.log(`  sourceQuestionId: ${q.sourceQuestionId ?? "(none)"}`);
    if (q.elaboration) {
      console.log(`  elaboration (first 600 chars):\n    ${q.elaboration.slice(0, 600).replace(/\n/g, "\n    ")}`);
    } else {
      console.log(`  elaboration: (none)`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
