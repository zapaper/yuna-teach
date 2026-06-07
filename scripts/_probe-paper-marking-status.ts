// Quick probe — show markingStatus + per-Q marks for a single paper so
// we can tell whether the "still marking" UI symptom is a real
// not-yet-marked or a stale state-machine flag.

import { prisma } from "../src/lib/db";

const PAPER_ID = process.argv[2] ?? "cmptfnvfc0005a6197bhqy6k0";

async function main() {
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: {
      id: true, title: true, score: true, totalMarks: true,
      markingStatus: true, paperType: true,
      completedAt: true,
      assignedToId: true,
      createdAt: true,
    },
  });
  if (!p) { console.log("not found"); return; }
  console.log(`paper: ${p.title}`);
  console.log(`  paperType=${p.paperType}  status=${p.markingStatus}  score=${p.score}/${p.totalMarks}`);
  console.log(`  completedAt=${p.completedAt?.toISOString() ?? "(null)"}  assignedToId=${p.assignedToId}`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, marksAvailable: true, marksAwarded: true, markingNotes: true },
  });
  let totalAvail = 0, totalAwarded = 0, nullCount = 0;
  for (const q of qs) {
    totalAvail += q.marksAvailable ?? 0;
    if (q.marksAwarded == null) nullCount++;
    totalAwarded += q.marksAwarded ?? 0;
  }
  console.log(`\n${qs.length} questions: ${nullCount} unmarked (marksAwarded=null)`);
  console.log(`  sum awarded=${totalAwarded}  sum available=${totalAvail}  paper.score=${p.score}`);

  // Show any rows whose notes look like a marking error
  const errs = qs.filter(q => q.markingNotes && /marking error|please re.?mark|AI unavailable/i.test(q.markingNotes ?? ""));
  if (errs.length > 0) {
    console.log(`\n${errs.length} rows have marker-error notes:`);
    for (const q of errs) {
      console.log(`  Q${q.questionNum}: marksAwarded=${q.marksAwarded}  notes="${(q.markingNotes ?? "").slice(0, 90)}"`);
    }
  }
  // Show unmarked Qs
  const nulls = qs.filter(q => q.marksAwarded == null);
  if (nulls.length > 0 && nulls.length <= 10) {
    console.log(`\nUnmarked questions:`);
    for (const q of nulls) {
      console.log(`  Q${q.questionNum}: ${q.marksAvailable}m  notes="${(q.markingNotes ?? "(null)").slice(0, 90)}"`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
