import { prisma } from "../src/lib/db";
const PAPER = "cmq37z11b0028cyy0pj3zeydm";
async function main() {
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { score: true, totalMarks: true, markingStatus: true },
  });
  console.log("Paper:", JSON.stringify(p));
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, marksAwarded: true, marksAvailable: true, syllabusTopic: true },
  });
  const total = qs.length;
  const marked = qs.filter(q => q.marksAwarded !== null).length;
  const correct = qs.filter(q => q.marksAwarded === q.marksAvailable && q.marksAvailable !== null).length;
  const partial = qs.filter(q => q.marksAwarded !== null && q.marksAwarded > 0 && q.marksAwarded < (q.marksAvailable ?? 0)).length;
  const zero = qs.filter(q => q.marksAwarded === 0).length;
  const unmarked = qs.filter(q => q.marksAwarded === null).length;
  console.log(`\nTotal: ${total} | Marked: ${marked} | Unmarked: ${unmarked}`);
  console.log(`Correct: ${correct} | Partial: ${partial} | Zero: ${zero}`);
  
  // Per-section breakdown
  const bySection = new Map<string, { total: number; marked: number; score: number; available: number }>();
  for (const q of qs) {
    const t = q.syllabusTopic ?? "(none)";
    if (!bySection.has(t)) bySection.set(t, { total: 0, marked: 0, score: 0, available: 0 });
    const s = bySection.get(t)!;
    s.total++;
    if (q.marksAwarded !== null) { s.marked++; s.score += q.marksAwarded; }
    s.available += q.marksAvailable ?? 0;
  }
  console.log(`\nPer section:`);
  for (const [t, s] of bySection) {
    const pct = s.available > 0 ? Math.round((s.score / s.available) * 100) : 0;
    console.log(`  ${t.padEnd(35)} ${s.score}/${s.available} (${pct}%) marked=${s.marked}/${s.total}`);
  }
  
  // Show Q41/Q42/Q56/Q57 specifically
  console.log(`\nDuplicate-bounds questions:`);
  for (const num of ["41", "42", "56", "57"]) {
    const q = qs.find(x => x.questionNum === num);
    if (q) console.log(`  Q${num}: ${q.marksAwarded}/${q.marksAvailable}`);
  }
  process.exit(0);
}
main();
