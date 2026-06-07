// Inspect the specific mastery paper that opened as full-exam format
// instead of quiz format. Check paperType, completedAt, sourceExamId,
// metadata, and any obvious routing-relevant fields.

import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmpl0f7ma00bt4u6fwh5u3be1";
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      paperType: true,
      examType: true,
      sourceExamId: true,
      assignedToId: true,
      userId: true,
      completedAt: true,
      markingStatus: true,
      visible: true,
      instantFeedback: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  console.log(JSON.stringify(paper, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
