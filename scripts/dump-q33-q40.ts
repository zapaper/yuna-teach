import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

const PAPER_IDS = [
  { year: 2016, id: "cmphqli6g002b98jke0olegzj" },
  { year: 2017, id: "cmphphlfd0001ivva0cvmq0du" },
  { year: 2018, id: "cmphqacp9000198jkrd6ambui" },
  { year: 2019, id: "cmparuwvl0001e4lryp826f9w" },
  { year: 2020, id: "cmpexr14i0001zmvgavm7u3k5" },
  { year: 2021, id: "cmp9tqp7r004p11pg1emv5dty" },
  { year: 2022, id: "cmp9muf3q00038gvnb269c3ht" },
  { year: 2023, id: "cmp9msmx800018gvnz0suifzq" },
  { year: 2024, id: "cmp9e8vzc0001ug93w4cq50y1" },
  { year: 2025, id: "cmphn6npc000112g1sdstau5j" },
];

(async () => {
  const out: string[] = [];
  for (const { year, id } of PAPER_IDS) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { questionNum: true, transcribedStem: true, answer: true, marksAvailable: true },
      orderBy: { orderIndex: "asc" },
    });
    for (const q of qs) {
      const num = parseInt((q.questionNum ?? "").replace(/\D/g, ""), 10);
      if (num === 33 || num === 40) {
        out.push(`\n========================================`);
        out.push(`${year}  Q${num}  (${q.marksAvailable}m)`);
        out.push(`========================================`);
        out.push(`STEM:\n${q.transcribedStem ?? ""}`);
        out.push(`\nMODEL ANSWER:\n${q.answer ?? ""}`);
      }
    }
  }
  const outPath = path.join(__dirname, "q33-q40-dump.txt");
  fs.writeFileSync(outPath, out.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
  await prisma.$disconnect();
})();
