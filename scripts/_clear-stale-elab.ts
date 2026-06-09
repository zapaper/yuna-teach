// Clear the stale (pre-Science-MCQ-imageData-fix) cached
// elaborations on specific questions so the next view re-generates
// against the new prompt that sends the full question image too.
//
// Targets are passed as paperId:questionNum pairs. The clone's
// elaboration is cleared AND the master's elaboration is cleared
// (clones inherit the master cache via canShareMasterElab, so just
// clearing the clone wouldn't help).
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_clear-stale-elab.ts \
//     cmq63oni3006reykwi6cshgzq:2 \
//     cmq4xhrnr001napq262sn8cj9:17

import { prisma } from "../src/lib/db";

(async () => {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: _clear-stale-elab.ts <paperId>:<questionNum> [<paperId>:<questionNum> ...]");
    process.exit(1);
  }
  let totalCleared = 0;
  for (const arg of args) {
    const [paperId, qNum] = arg.split(":");
    if (!paperId || !qNum) {
      console.error(`bad arg "${arg}" — expected paperId:questionNum`);
      continue;
    }

    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
      select: { id: true, title: true, sourceExamId: true },
    });
    if (!paper) {
      console.error(`paper not found: ${paperId}`);
      continue;
    }
    console.log(`\n--- ${arg} (${paper.title}) ---`);

    const cloneQ = await prisma.examQuestion.findFirst({
      where: { examPaperId: paperId, questionNum: qNum },
      select: { id: true, sourceQuestionId: true, elaboration: true },
    });
    if (!cloneQ) {
      console.error(`  Q${qNum} not found on paper ${paperId}`);
      continue;
    }
    if (cloneQ.elaboration) {
      await prisma.examQuestion.update({
        where: { id: cloneQ.id },
        data: { elaboration: null },
      });
      console.log(`  cleared clone elaboration (id=${cloneQ.id}, was ${cloneQ.elaboration.length} chars)`);
      totalCleared++;
    } else {
      console.log(`  clone elaboration already null (id=${cloneQ.id})`);
    }

    if (cloneQ.sourceQuestionId) {
      const masterQ = await prisma.examQuestion.findUnique({
        where: { id: cloneQ.sourceQuestionId },
        select: { id: true, elaboration: true },
      });
      if (masterQ?.elaboration) {
        await prisma.examQuestion.update({
          where: { id: masterQ.id },
          data: { elaboration: null },
        });
        console.log(`  cleared master elaboration (id=${masterQ.id}, was ${masterQ.elaboration.length} chars)`);
        totalCleared++;
      } else {
        console.log(`  master elaboration already null (id=${cloneQ.sourceQuestionId})`);
      }
    } else {
      console.log(`  no master (sourceQuestionId is null)`);
    }
  }
  console.log(`\nTotal cleared: ${totalCleared}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
