import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";
const PAPER = "cmq37z11b0028cyy0pj3zeydm";
const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, questionNum: { in: ["1", "2", "3", "4", "5"] } },
    select: { id: true, questionNum: true, pageIndex: true, yStartPct: true, yEndPct: true, marksAwarded: true, marksAvailable: true, markingNotes: true, printableBounds: true, transcribedOptions: true, answer: true, studentAnswer: true },
    orderBy: { orderIndex: "asc" },
  });
  for (const q of qs) {
    console.log(`\n=== Q${q.questionNum} ===`);
    console.log(`  pageIndex=${q.pageIndex} y=${q.yStartPct}-${q.yEndPct} marks=${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`  hasOpts=${Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4}`);
    console.log(`  answer=${q.answer} studentAnswer=${q.studentAnswer}`);
    console.log(`  printableBounds=${JSON.stringify(q.printableBounds)}`);
    console.log(`  notes: ${(q.markingNotes ?? "").slice(0, 200)}`);
  }
  console.log("\n=== Files in submissions dir (Railway disk) ===");
  console.log(`VOLUME_PATH=${VOLUME_PATH}`);
  const subDir = path.join(VOLUME_PATH, "submissions", PAPER);
  try {
    const files = fs.readdirSync(subDir).sort();
    console.log(`Total files: ${files.length}`);
    console.log(`First 15:`, files.slice(0, 15).join(", "));
  } catch (e) {
    console.log(`(can't read local: ${e instanceof Error ? e.message : e})`);
  }
  process.exit(0);
}
main();
