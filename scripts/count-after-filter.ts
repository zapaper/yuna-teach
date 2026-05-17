import { prisma } from "../src/lib/db";
(async () => {
  const sid = "cmm5wf91d000ryrxwaddlo6xh";
  const baseCount = await prisma.examPaper.count({
    where: {
      assignedToId: sid,
      completedAt: { not: null },
      subject: { contains: "english", mode: "insensitive" },
    },
  });
  console.log("base (with revision):", baseCount);
  const filteredCount = await prisma.examPaper.count({
    where: {
      assignedToId: sid,
      completedAt: { not: null },
      subject: { contains: "english", mode: "insensitive" },
      NOT: [
        { metadata: { path: ["revisionMode"], equals: "review" } },
        { metadata: { path: ["revisionMode"], equals: "practice" } },
      ],
    },
  });
  console.log("filtered (without revision):", filteredCount);
  await prisma.$disconnect();
})();
