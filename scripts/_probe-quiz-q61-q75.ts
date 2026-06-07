import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmps3x4mt004l2nr7opoak80p";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, orderIndex: true,
      marksAvailable: true, marksAwarded: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedOptionTable: true,
      transcribedSubparts: true,
      transcribedStem: true,
      printableBounds: true,
      studentAnswer: true,
      markingNotes: true,
      syllabusTopic: true,
    },
  });
  for (const q of qs) {
    if (parseInt(q.questionNum, 10) < 61) continue;
    const opts = q.transcribedOptions as unknown[] | null;
    const imgs = q.transcribedOptionImages as unknown[] | null;
    const tbl = q.transcribedOptionTable as { rows?: unknown } | null;
    const subs = q.transcribedSubparts as unknown[] | null;
    console.log(`Q${q.questionNum} idx=${q.orderIndex} topic="${q.syllabusTopic}"`);
    console.log(`  opts=${opts === null ? "null" : `Array(${opts.length})`} ${JSON.stringify(opts).slice(0, 100)}`);
    console.log(`  imgs=${imgs === null ? "null" : `Array(${imgs.length})`} someTruthy=${imgs ? imgs.some(x => !!x) : "N/A"}`);
    console.log(`  tbl=${tbl ? "present" : "null"}`);
    console.log(`  subs=${subs === null ? "null" : `Array(${subs.length})`} ${JSON.stringify(subs).slice(0,140)}`);
    console.log(`  awarded=${q.marksAwarded} notes="${q.markingNotes}" stu="${(q.studentAnswer ?? "").slice(0,140)}"`);
    console.log(`  printableBounds=${JSON.stringify(q.printableBounds)}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
