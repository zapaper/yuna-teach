import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const qs = await prisma.examQuestion.findMany({
    where: {
      AND: [
        { transcribedStem: { contains: "diver", mode: "insensitive" } },
        { transcribedStem: { contains: "goggles", mode: "insensitive" } },
      ],
      examPaper: { assignedToId: "cmmbbyvs30004qa9yinn3drl6" },
    },
    select: {
      id: true, questionNum: true, transcribedStem: true, answer: true,
      studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true,
      examPaper: { select: { id: true, title: true, createdAt: true } },
    },
  });
  console.log(JSON.stringify(qs, null, 2));
  await prisma.$disconnect();
})();
