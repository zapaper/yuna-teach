// How many marks of PSLE Chinese Paper 2 directly test connectors
// (关联词)? Look across all 10 years' question topics + sub-topics
// + stems to count both:
//   - explicit connector questions (Q9-10 标准 关联词)
//   - other questions where the answer requires picking the right
//     connector (cloze, dialogue, comprehension)

import { prisma } from "../src/lib/db";

const CHINESE_PAPER_IDS = [
  { year: "2016", id: "cmphqli6g002b98jke0olegzj" },
  { year: "2017", id: "cmphphlfd0001ivva0cvmq0du" },
  { year: "2018", id: "cmphqacp9000198jkrd6ambui" },
  { year: "2019", id: "cmparuwvl0001e4lryp826f9w" },
  { year: "2020", id: "cmparv40c0003e4lrg48z2b7v" },
  { year: "2021", id: "cmp9tqp7r004p11pg1emv5dty" },
  { year: "2022", id: "cmp9muf3q00038gvnb269c3ht" },
  { year: "2023", id: "cmp9msmx800018gvnz0suifzq" },
  { year: "2024", id: "cmp9e8vzc0001ug93w4cq50y1" },
  { year: "2025", id: "cmphn6npc000112g1sdstau5j" },
];

// A small bank of connector words. Used to detect connectors inside
// option lists / cloze blanks for non-Q9-10 questions.
const CONNECTOR_TOKENS = [
  "因为", "所以", "由于", "因此", "因而", "既然",
  "虽然", "但是", "不过", "可是", "然而", "尽管", "即使", "纵然",
  "如果", "假如", "要是", "倘若", "只要", "只有", "除非", "无论", "不管",
  "不但", "不仅", "而且", "并且", "况且", "甚至", "反而",
  "一边", "一面", "一会儿", "时而",
  "首先", "然后", "接着", "随后", "最后", "终于",
  "于是", "便", "就", "才",
  "或者", "还是",
  "是…还是", "不是…就是", "既…又", "又…又",
  "一……就", "之所以", "可见",
];

function hasConnector(text: string | null): boolean {
  if (!text) return false;
  return CONNECTOR_TOKENS.some(c => text.includes(c));
}

async function main() {
  console.log("year\ttotal\tdirect_connector\toption_has_connector\tcloze_has_connector\testimated_total");
  const yearStats: Array<{ year: string; direct: number; optConn: number; cloze: number; total: number; estTotal: number }> = [];

  for (const { year, id } of CHINESE_PAPER_IDS) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: {
        questionNum: true, marksAvailable: true, syllabusTopic: true, subTopic: true,
        transcribedStem: true, transcribedOptions: true,
      },
      orderBy: { orderIndex: "asc" },
    });
    let direct = 0, optConn = 0, cloze = 0, total = 0;
    for (const q of qs) {
      const marks = q.marksAvailable ?? 0;
      total += marks;
      const topic = q.syllabusTopic ?? "";
      const sub = q.subTopic ?? "";
      const isDirect = topic.includes("关联词") || sub.includes("关联词") ||
        (topic.toLowerCase().includes("connector"));
      if (isDirect) { direct += marks; continue; }

      // Otherwise: look at options to see if connector words appear.
      const opts = (q.transcribedOptions as string[] | null) ?? [];
      const optionHasConnector = opts.some(o => hasConnector(o));
      const isCloze = topic.includes("短文填空") || topic.includes("Comprehension Cloze") ||
        topic.includes("完成对话");
      if (isCloze && optionHasConnector) { cloze += marks; continue; }
      if (optionHasConnector) optConn += marks;
    }
    const est = direct + cloze + optConn;
    yearStats.push({ year, direct, optConn, cloze, total, estTotal: est });
    console.log(`${year}\t${total}\t${direct}\t${optConn}\t${cloze}\t${est}`);
  }

  console.log("\n=== Aggregate (10 years) ===");
  const dSum = yearStats.reduce((s, r) => s + r.direct, 0);
  const cSum = yearStats.reduce((s, r) => s + r.cloze, 0);
  const oSum = yearStats.reduce((s, r) => s + r.optConn, 0);
  const total = yearStats.reduce((s, r) => s + r.total, 0);
  console.log(`Total paper marks across 10 years: ${total}`);
  console.log(`Direct connector questions (Q9-10 style): ${dSum} marks (${(dSum / yearStats.length).toFixed(1)}/year)`);
  console.log(`Cloze/dialogue questions with connector option: ${cSum} marks (${(cSum / yearStats.length).toFixed(1)}/year)`);
  console.log(`Other MCQs with connector in options: ${oSum} marks (${(oSum / yearStats.length).toFixed(1)}/year)`);
  console.log(`Conservative est. (direct + cloze): ${dSum + cSum} marks (${((dSum + cSum) / yearStats.length).toFixed(1)}/year)`);
  console.log(`Broad est. (incl. opt-has-connector): ${dSum + cSum + oSum} marks (${((dSum + cSum + oSum) / yearStats.length).toFixed(1)}/year)`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
