import { prisma } from "../src/lib/db";

async function main() {
  // Find any answers that contain "| Explanation:" — this is the user's
  // pain point. See which papers they belong to and how those papers
  // identify as "PSLE".
  const qs = await prisma.examQuestion.findMany({
    where: { answer: { contains: "Explanation:", mode: "insensitive" } },
    select: {
      questionNum: true,
      answer: true,
      examPaper: { select: { title: true, school: true, level: true, subject: true, examType: true, year: true } },
    },
    take: 10,
  });
  console.log(`Found ${qs.length} sample questions with "Explanation:" in answer.\n`);
  for (const q of qs) {
    console.log(`--- Q${q.questionNum} ---`);
    console.log(`paper: school="${q.examPaper.school}" subject="${q.examPaper.subject}" level="${q.examPaper.level}" examType="${q.examPaper.examType}" year="${q.examPaper.year}" title="${q.examPaper.title}"`);
    console.log(`answer: ${q.answer?.slice(0, 200)}`);
    console.log();
  }

  // Also show what distinguishes PSLE papers
  const psleSamples = await prisma.examPaper.findMany({
    where: {
      OR: [
        { school: { contains: "PSLE", mode: "insensitive" } },
        { title: { contains: "PSLE", mode: "insensitive" } },
        { level: { contains: "PSLE", mode: "insensitive" } },
      ],
    },
    select: { school: true, level: true, subject: true, examType: true, title: true },
    take: 5,
  });
  console.log("Sample PSLE-flagged papers:");
  console.log(JSON.stringify(psleSamples, null, 2));

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
