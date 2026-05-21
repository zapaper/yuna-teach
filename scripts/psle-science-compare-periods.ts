// Compare topic frequency between PSLE 2020-2021 (full papers) and
// PSLE 2022-2024 (selected MCQ + OEQ master subsets) to flag any topic
// with a stark difference.
import { prisma } from "../src/lib/db";

type Row = { qs: number; marks: number };

async function tally(titles: string[]): Promise<{ totalQs: number; totalMarks: number; byTopic: Map<string, Row>; paperCount: number }> {
  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null, title: { in: titles } },
    select: { id: true, title: true },
  });
  const byTopic = new Map<string, Row>();
  let totalQs = 0, totalMarks = 0;
  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { syllabusTopic: true, marksAvailable: true },
    });
    for (const q of qs) {
      totalQs++;
      totalMarks += q.marksAvailable ?? 0;
      const topic = (q.syllabusTopic ?? "(no topic)").trim();
      const row = byTopic.get(topic) ?? { qs: 0, marks: 0 };
      row.qs++;
      row.marks += q.marksAvailable ?? 0;
      byTopic.set(topic, row);
    }
  }
  return { totalQs, totalMarks, byTopic, paperCount: papers.length };
}

(async () => {
  const a = await tally(["PSLE Science 2020", "PSLE Science 2021"]);
  const b = await tally([
    "PSLE Physical Science MCQ 2022-2024",
    "PSLE Physical science OEQ 2022-2024",
    "PSLE Life Science OEQ 2022-2024",
    "P6 Life Science MCQ 2022-2024", // user confirms this completes the 2022-2024 set
  ]);
  console.log(`\n=== 2020-2021 (2 full papers): ${a.totalQs} qs / ${a.totalMarks} marks ===`);
  console.log(`=== 2022-2024 (3 selected masters): ${b.totalQs} qs / ${b.totalMarks} marks ===`);
  console.log();
  // Union of all topics
  const topics = new Set<string>();
  for (const k of a.byTopic.keys()) topics.add(k);
  for (const k of b.byTopic.keys()) topics.add(k);
  const sortedTopics = [...topics].sort();
  const fmt = (n: number, w: number) => String(n).padStart(w);
  const pct = (q: number, total: number) => total ? `${((q / total) * 100).toFixed(1)}%` : "—";
  console.log(
    "Topic".padEnd(60).slice(0, 60) +
    " | 20-21 Qs/yr (% marks) | 22-24 Qs/yr (% marks) | flag"
  );
  console.log("-".repeat(120));
  for (const t of sortedTopics) {
    const ra = a.byTopic.get(t) ?? { qs: 0, marks: 0 };
    const rb = b.byTopic.get(t) ?? { qs: 0, marks: 0 };
    const perYrA = ra.qs / 2;
    const perYrB = rb.qs / 3;
    const pctA = a.totalMarks ? (ra.marks / a.totalMarks) * 100 : 0;
    const pctB = b.totalMarks ? (rb.marks / b.totalMarks) * 100 : 0;
    const diff = pctA - pctB;
    const flag = Math.abs(diff) > 4 ? (diff > 0 ? "  ↑ in 20-21" : "  ↓ in 20-21") : "";
    console.log(
      t.padEnd(60).slice(0, 60) +
      ` | ${perYrA.toFixed(1).padStart(4)} qs ${pct(ra.marks, a.totalMarks).padStart(6)} | ${perYrB.toFixed(1).padStart(4)} qs ${pct(rb.marks, b.totalMarks).padStart(6)} |${flag}`
    );
  }
  await prisma.$disconnect();
})();
