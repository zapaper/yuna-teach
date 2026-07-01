import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  // A — PSLE 2022 Q7 exact answer
  console.log(`── A. PSLE 2022 Q7 (Mr Thomas trouble starting car) ──`);
  const a = await prisma.examQuestion.findFirst({
    where: {
      transcribedStem: { contains: "trouble starting his car", mode: "insensitive" },
      examPaper: { sourceExamId: null, paperType: null, year: "2022", subject: { contains: "english", mode: "insensitive" } },
    },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, syllabusTopic: true, subTopic: true },
  });
  if (a) {
    const opts = Array.isArray(a.transcribedOptions) ? (a.transcribedOptions as string[]) : [];
    const idx = parseInt((a.answer ?? "").replace(/[()]/g, "").trim(), 10) - 1;
    const optText = idx >= 0 && idx < opts.length ? opts[idx] : "?";
    console.log(`  stem: ${a.transcribedStem}`);
    console.log(`  options: ${opts.map((o, i) => `(${i+1})${o}`).join("  ")}`);
    console.log(`  answer index in DB: ${a.answer}  → resolves to: "${optText}"`);
    console.log(`  syllabusTopic: ${a.syllabusTopic}   subTopic: ${a.subTopic}`);
  }

  // Sub-topic distribution across PSLE Grammar MCQ 2014-2025 (12 years)
  console.log(`\n── Sub-topic distribution across PSLE 2014-2025 Grammar MCQ ──`);
  const rows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Grammar MCQ",
      examPaper: {
        sourceExamId: null, paperType: null,
        subject: { contains: "english", mode: "insensitive" },
        year: { in: ["2014","2015","2016","2017","2018","2019","2020","2021","2022","2023","2024","2025"] },
      },
    },
    select: { subTopic: true },
  });
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.subTopic ?? "(untagged)", (counts.get(r.subTopic ?? "(untagged)") ?? 0) + 1);
  const total = rows.length;
  console.log(`  Total PSLE Grammar MCQ 2014-2025: ${total}`);
  for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = (n / total * 100).toFixed(1);
    console.log(`    ${k.padEnd(25)}  n=${n.toString().padStart(3)}  ${pct.padStart(5)}%`);
  }
  await prisma.$disconnect();
})();
