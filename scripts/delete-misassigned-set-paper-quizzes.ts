// One-off: delete the 5 mis-assigned Test Quizzes created by the
// English/Chinese Set Papers flow before commit feaa6173 fixed the
// assignedToId bug. User authorised deletion ("Delete them instead"
// / "Delete it") rather than re-assigning.
//
// Usage:
//   npx tsx scripts/delete-misassigned-set-paper-quizzes.ts          # dry-run
//   npx tsx scripts/delete-misassigned-set-paper-quizzes.ts --write  # apply

import { prisma } from "../src/lib/db";

const QUIZ_IDS = [
  "cmps7osmz003mnnrzmhed35ej", // Test Quiz — PSLE English 2019
  "cmps7n5eh001cnnrz8dyd36z0", // Test Quiz — PSLE English Language 2015
  "cmps2e3g0002bubwjs4db46n5", // Test Quiz — PSLE English Language 2015
  "cmps26lss0001ubwjtm80yuis", // Test Quiz — PSLE English Language 2015
  "cmps0230r0001jqcho5hb56xd", // Test Quiz — P6 Chinese Prelim NanHua 2025
];

async function main() {
  const write = process.argv.includes("--write");
  for (const id of QUIZ_IDS) {
    const q = await prisma.examPaper.findUnique({
      where: { id },
      select: { id: true, title: true, paperType: true, _count: { select: { questions: true } } },
    });
    if (!q) {
      console.log(`(missing) ${id}`);
      continue;
    }
    if (q.paperType !== "quiz") {
      console.log(`SKIP (paperType=${q.paperType}, not quiz) ${id} — ${q.title}`);
      continue;
    }
    console.log(`${write ? "DELETE" : "WOULD DELETE"}  id=${id}  questions=${q._count.questions}  title="${q.title}"`);
    if (write) {
      // Cascade deletes on the schema's ExamQuestion relation should
      // handle child rows; if not, fall back to manual nested delete.
      await prisma.examPaper.delete({ where: { id } });
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
