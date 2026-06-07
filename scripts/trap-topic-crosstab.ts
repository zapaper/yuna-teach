// For each trap pattern, show the topic distribution of the questions
// tagged with it — confirms whether traps overlap with topics
// (they should — every question gets exactly one topic + zero/more
// traps).

import { promises as fs } from "fs";
import path from "path";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const norm = (s: string) => s.replace(/^Q/, "");

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  const TRAP = "combined_figure_area_subtraction";
  console.log(`=== ${TRAP}: topic of each tagged question ===\n`);
  const byTopic = new Map<string, { qs: number; marks: number }>();
  for (const p of papers) {
    const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
    for (const q of p.questions) {
      const c = classByNum.get(norm(q.questionNum));
      if (!c?.traps?.includes(TRAP)) continue;
      const t = c.topic;
      const cur = byTopic.get(t) ?? { qs: 0, marks: 0 };
      cur.qs += 1;
      cur.marks += q.marksAvailable ?? 0;
      byTopic.set(t, cur);
      console.log(`  ${p.year} Q${q.questionNum} (${q.marksAvailable}m) → topic: ${t}`);
    }
  }
  console.log(`\nTopic distribution for ${TRAP}:`);
  for (const [t, st] of [...byTopic.entries()].sort((a, b) => b[1].marks - a[1].marks)) {
    console.log(`  ${t.padEnd(25)} ${st.qs}Q  ${st.marks}m`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
