import { prisma } from "../src/lib/db";
async function main() {
  const id = "cmpw897te0001alhznj511oi5";
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: id, questionNum: "9" },
    select: {
      id: true, questionNum: true,
      marksAwarded: true, marksAvailable: true,
      markingNotes: true,
      transcribedSubparts: true,
    },
  });
  console.log(JSON.stringify(q, null, 2));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
