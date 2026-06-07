import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type BankEntry = { word: string; chars: number; category: string; source: string };

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
  const bank = JSON.parse(fs.readFileSync(path.join(__dirname, "psle-chinese-study-bank.json"), "utf8")) as BankEntry[];
  const wordlistP4P6 = new Set(bank.filter(e => e.source !== "PSLE").map(e => e.word));

  const tested = new Set<string>();
  for (const { id } of PAPER_IDS) {
    const qs = await prisma.examQuestion.findMany({
      where: {
        examPaperId: id,
        OR: [
          { syllabusTopic: { contains: "语文应用" } },
          { syllabusTopic: { contains: "短文填空" } },
        ],
      },
      select: { answer: true, transcribedStem: true, transcribedOptions: true },
    });
    for (const q of qs) {
      const opts = q.transcribedOptions as string[] | null;
      if (!Array.isArray(opts) || opts.length !== 4) continue;
      const m = q.answer?.match(/[1-4]/);
      if (m) {
        const w = opts[parseInt(m[0], 10) - 1]?.replace(/\*+|_+/g, "").trim();
        if (w && w.length <= 6) tested.add(w);
      }
      for (const um of (q.transcribedStem ?? "").matchAll(/_+([^_]+)_+/g)) {
        const w = um[1].replace(/\*+/g, "").trim();
        if (w && w.length <= 6) tested.add(w);
      }
    }
  }

  function classify(w: string): string {
    if (/^(因为|所以|但是|可是|不但|而且|虽然|尽管|如果|只要|只有|不管|无论|由于|除了|不仅|宁愿|于是|即使|否则)/.test(w) || w.includes("……")) return "连接词";
    if (w.length >= 4) return "成语 / 4-char";
    if (w.length === 3) return "3-char";
    return "2-char";
  }

  const byCat = new Map<string, { tested: string[]; inList: string[] }>();
  for (const w of tested) {
    const c = classify(w);
    const cat = byCat.get(c) ?? { tested: [], inList: [] };
    cat.tested.push(w);
    if (wordlistP4P6.has(w)) cat.inList.push(w);
    byCat.set(c, cat);
  }

  const total = tested.size;
  const totalInList = [...tested].filter(w => wordlistP4P6.has(w)).length;
  console.log(`\nStrict tested words (correct opt OR underlined stem): ${total}`);
  console.log(`In P4-P6 wordlist (944 entries): ${totalInList} (${(totalInList / total * 100).toFixed(1)}%)\n`);
  console.log(`By category:\n`);
  for (const [cat, { tested: t, inList }] of [...byCat.entries()].sort((a, b) => b[1].tested.length - a[1].tested.length)) {
    const pct = (inList.length / t.length * 100).toFixed(0);
    console.log(`  ${cat.padEnd(20)} ${String(t.length).padStart(4)} tested, ${String(inList.length).padStart(3)} in list  (${pct}%)`);
    if (inList.length > 0) console.log(`    ✓ in list: ${inList.join("、")}`);
    const notInList = t.filter(w => !wordlistP4P6.has(w));
    if (notInList.length > 0) console.log(`    ✗ missing: ${notInList.slice(0, 20).join("、")}${notInList.length > 20 ? `  …+${notInList.length - 20}` : ""}`);
  }
  await prisma.$disconnect();
})();
