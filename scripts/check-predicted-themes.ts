// Scan all 20 model essays + topic stems for the themes Gemini
// predicted as "likely next year". If they don't actually appear,
// the prediction is hallucinated and we should redo Stage A with
// stricter grounding.

import { prisma } from "../src/lib/db";

const PROBE_KEYWORDS: Array<{ theme: string; keywords: string[] }> = [
  { theme: "诚实 (Honesty)", keywords: ["诚实", "撒谎", "说谎", "实话", "真相", "坦白", "不诚实"] },
  { theme: "宽容 (Tolerance)", keywords: ["宽容", "原谅", "包容", "谅解", "宽恕", "释怀"] },
  { theme: "面对挫折的勇气 (Courage in setbacks)", keywords: ["挫折", "失败", "灰心", "气馁", "不放弃", "再试一次", "卷土重来", "重新站起来"] },
];

async function main() {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: { status: "ready" },
    orderBy: { year: "asc" },
    select: {
      year: true,
      compoOption1Topic: true, compoOption2: true,
      compoOption1Model: true, compoOption2Model: true,
    },
  });

  for (const probe of PROBE_KEYWORDS) {
    console.log(`\n=== "${probe.theme}" — keywords: ${probe.keywords.join(", ")} ===`);
    let totalHits = 0;
    for (const r of rows) {
      const o2 = r.compoOption2 as { helpingWords?: string[]; instructions?: string } | null;
      const haystack = [
        `[O1 题目] ${r.compoOption1Topic ?? ""}`,
        `[O2 指示] ${o2?.instructions ?? ""}`,
        `[O2 帮助词] ${o2?.helpingWords?.join(" ") ?? ""}`,
        `[O1 范文] ${r.compoOption1Model ?? ""}`,
        `[O2 范文] ${r.compoOption2Model ?? ""}`,
      ].join("\n");
      const hits = probe.keywords.filter(k => haystack.includes(k));
      if (hits.length > 0) {
        totalHits += 1;
        // show context — find a snippet around the first hit
        const k = hits[0];
        const idx = haystack.indexOf(k);
        const ctx = haystack.slice(Math.max(0, idx - 40), idx + 60).replace(/\s+/g, " ");
        console.log(`  ${r.year} hits ${hits.join(", ")}  …${ctx}…`);
      }
    }
    if (totalHits === 0) console.log(`  → NO HITS in any year. This prediction is unsupported by the data.`);
    else console.log(`  → ${totalHits}/10 years touch this theme.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
