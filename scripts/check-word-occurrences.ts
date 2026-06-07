import { prisma } from "../src/lib/db";

const PAPER_IDS: Array<{ year: number; id: string }> = [
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

const TARGET_WORDS = process.argv.slice(2).filter(a => /[一-鿿]/.test(a));
if (TARGET_WORDS.length === 0) TARGET_WORDS.push("恍然大悟", "津津有味", "垂头丧气", "目不转睛");

(async () => {
  for (const word of TARGET_WORDS) {
    console.log(`\n=== ${word} ===`);
    for (const { year, id } of PAPER_IDS) {
      const qs = await prisma.examQuestion.findMany({
        where: {
          examPaperId: id,
          OR: [
            { transcribedStem: { contains: word } },
            { transcribedOptions: { array_contains: word } },
          ],
        },
        select: { questionNum: true, syllabusTopic: true, answer: true, transcribedStem: true, transcribedOptions: true },
      });
      for (const q of qs) {
        const opts = q.transcribedOptions as string[] | null;
        const ansMatch = q.answer?.match(/[1-4]/);
        const ansIdx = ansMatch ? parseInt(ansMatch[0], 10) - 1 : -1;
        const correctOpt = opts && ansIdx >= 0 ? opts[ansIdx] : null;
        let role: string;
        if (correctOpt?.includes(word)) role = "★ CORRECT ANSWER";
        else if (opts?.some(o => o.includes(word))) role = "in option (distractor)";
        else if (q.transcribedStem?.includes(word)) role = "in stem";
        else role = "match?";
        console.log(`  ${year} Q${q.questionNum} (${q.syllabusTopic}) [${role}] ans=${q.answer ?? "—"}`);
        if (opts) {
          for (let i = 0; i < opts.length; i++) {
            const hit = opts[i].includes(word) ? "  ←" : "";
            console.log(`    (${i + 1}) ${opts[i].slice(0, 60)}${hit}`);
          }
        }
      }
    }
  }
  await prisma.$disconnect();
})();
