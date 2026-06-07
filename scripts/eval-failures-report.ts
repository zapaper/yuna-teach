// Build a paste-friendly report of the most-recent marking-eval failures,
// with a clickable /exam/<id>/review URL per paper. Reads eval/results.json.
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

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "..", "eval", "results.json"), "utf8");
  const data: Results = JSON.parse(raw);

  const failing = data.results.filter(r => !r.pass);

  // Look up assignedToId (student) for review URLs — auth requires it.
  const ids = failing.map(r => r.sourceId);
  const papers = await prisma.examPaper.findMany({
    where: { id: { in: ids } },
    select: { id: true, assignedToId: true, userId: true, title: true, subject: true },
  });
  const meta = new Map(papers.map(p => [p.id, p]));

  console.log(`Marking eval: ${data.summary.questions.matched}/${data.summary.questions.total} questions match within ±${data.tolerance} (${((data.summary.questions.matched / data.summary.questions.total) * 100).toFixed(1)}%)`);
  console.log(`Papers: ${data.summary.papers.passed}/${data.summary.papers.total} pass`);
  console.log(`Ran at: ${data.ranAt}\n`);

  console.log(`=== FAILING PAPERS (${failing.length}) ===\n`);
  for (const r of failing) {
    const m = meta.get(r.sourceId);
    const userId = m?.assignedToId ?? m?.userId ?? "";
    const reviewUrl = `${BASE}/exam/${r.sourceId}/review?userId=${userId}`;
    console.log(`📝 ${r.title}`);
    console.log(`   subject: ${m?.subject ?? "?"}`);
    console.log(`   ${reviewUrl}`);
    console.log(`   ${r.matched}/${r.total} match · total ${r.actualTotal} vs ${r.expectedTotal} expected`);
    for (const d of r.diffs.filter(x => !x.pass)) {
      const sign = d.delta > 0 ? "+" : "";
      console.log(`     Q${d.questionNum}: expected ${d.expected}, got ${d.actual} (Δ${sign}${d.delta})`);
    }
    console.log();
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
