// Dump Q<N> for the MASTER paper that the given clone paper was
// generated from. Lets us check whether the (a)+(b) answer existed
// on the master and got lost during clone, or was never extracted
// in the first place.
//
// Usage:
//   npx tsx scripts/dump-master-q.ts <clonePaperId> [qNum]

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const clonePaperId = process.argv[2];
  const qNum = process.argv[3] ?? "6";
  if (!clonePaperId) {
    console.error("Usage: npx tsx scripts/dump-master-q.ts <clonePaperId> [qNum]");
    process.exit(1);
  }

  const clone = await prisma.examPaper.findUnique({
    where: { id: clonePaperId },
    select: { id: true, title: true, sourceExamId: true, paperType: true, assignedToId: true },
  });
  if (!clone) {
    console.log("No paper with that id.");
    return;
  }
  console.log(`Clone:  ${clone.id}  "${clone.title}"`);
  console.log(`        paperType=${clone.paperType ?? "(null = master)"}  assignedTo=${clone.assignedToId ?? "(none)"}`);
  console.log(`        sourceExamId=${clone.sourceExamId ?? "(none)"}`);

  const masterId = clone.sourceExamId ?? clone.id;
  if (masterId !== clone.id) {
    const master = await prisma.examPaper.findUnique({
      where: { id: masterId },
      select: { id: true, title: true },
    });
    console.log(`Master: ${master?.id} "${master?.title}"`);
  } else {
    console.log("(this paper is itself the master)");
  }
  console.log("");

  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: masterId, questionNum: qNum },
    select: {
      id: true,
      questionNum: true,
      answer: true,
      transcribedSubparts: true,
      elaboration: true,
    },
  });
  if (!q) {
    console.log(`No question ${qNum} on the master.`);
    return;
  }

  const showLong = (s: string | null | undefined, n = 1500) =>
    !s ? "(empty)" : s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s;

  console.log(`Master Q${q.questionNum} — id=${q.id}`);
  console.log("");
  console.log("ANSWER:");
  console.log(showLong(q.answer));
  console.log("");
  console.log("SUBPARTS:");
  console.log(JSON.stringify(q.transcribedSubparts, null, 2));
  console.log("");
  console.log("ELABORATION:");
  console.log(showLong(q.elaboration));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
