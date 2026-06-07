// For each failing question in the most-recent eval, fetch the EVAL CLONE's
// marker notes side-by-side with the SOURCE paper's "ground truth" notes.
// Lets the user see what the marker said this run vs what was previously
// accepted as correct.
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";

type DiffEntry = { questionNum: string; expected: number | null; actual: number | null; delta: number; pass: boolean };
type PaperResult = {
  sourceId: string;
  cloneId: string;
  title: string;
  expectedTotal: number;
  actualTotal: number;
  pass: boolean;
  matched: number;
  total: number;
  diffs: DiffEntry[];
};
type Results = {
  ranAt: string;
  tolerance: number;
  summary: { papers: { passed: number; total: number }; questions: { matched: number; total: number } };
  results: PaperResult[];
};

const BASE = process.env.EVAL_REMOTE_BASE ?? "https://www.markforyou.com";

function truncate(s: string | null | undefined, n = 600): string {
  if (!s) return "(none)";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "..", "eval", "results.json"), "utf8");
  const data: Results = JSON.parse(raw);

  const failing = data.results.filter(r => !r.pass);
  console.log(`Eval: ${data.summary.questions.matched}/${data.summary.questions.total} match (${((data.summary.questions.matched / data.summary.questions.total) * 100).toFixed(1)}%)`);
  console.log(`Ran at: ${data.ranAt}\n`);

  for (const r of failing) {
    console.log("═".repeat(90));
    console.log(`📝 ${r.title}`);
    console.log(`   sourceId: ${r.sourceId}`);
    console.log(`   cloneId:  ${r.cloneId}`);
    console.log(`   ${BASE}/exam/${r.sourceId}/review?userId=<student>`);
    console.log(`   ${r.matched}/${r.total} match · total ${r.actualTotal} vs ${r.expectedTotal} expected`);
    console.log();

    const failingNums = r.diffs.filter(d => !d.pass).map(d => d.questionNum);

    const [sourceQs, cloneQs] = await Promise.all([
      prisma.examQuestion.findMany({
        where: { examPaperId: r.sourceId, questionNum: { in: failingNums } },
        select: {
          questionNum: true,
          answer: true,
          studentAnswer: true,
          marksAvailable: true,
          marksAwarded: true,
          markingNotes: true,
        },
      }),
      prisma.examQuestion.findMany({
        where: { examPaperId: r.cloneId, questionNum: { in: failingNums } },
        select: {
          questionNum: true,
          marksAwarded: true,
          markingNotes: true,
        },
      }),
    ]);

    const sourceByNum = new Map(sourceQs.map(q => [q.questionNum, q]));
    const cloneByNum = new Map(cloneQs.map(q => [q.questionNum, q]));

    for (const d of r.diffs.filter(x => !x.pass)) {
      const src = sourceByNum.get(d.questionNum);
      const cln = cloneByNum.get(d.questionNum);
      const sign = d.delta > 0 ? "+" : "";
      console.log(`──── Q${d.questionNum} ──── expected ${d.expected}, got ${d.actual} (Δ${sign}${d.delta})  (avail: ${src?.marksAvailable})`);
      console.log(`  ANSWER KEY:`);
      console.log(`    ${truncate(src?.answer, 400)}`);
      console.log(`  STUDENT ANSWER:`);
      console.log(`    ${truncate(src?.studentAnswer, 400)}`);
      console.log(`  PREVIOUS marker notes (the "expected" baseline):`);
      console.log(`    ${truncate(src?.markingNotes, 600)}`);
      console.log(`  THIS-RUN marker notes (the deviation):`);
      console.log(`    ${truncate(cln?.markingNotes, 600)}`);
      console.log();
    }
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
