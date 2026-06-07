import { prisma } from "../src/lib/db";

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      NOT: { title: { startsWith: "Test Quiz" } },
      AND: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { OR: [
            { title: { contains: "science", mode: "insensitive" } },
          ] },
      ],
    },
    select: { id: true, title: true, year: true },
    orderBy: { title: "asc" },
  });
  for (const p of papers) {
    console.log(`${p.title}  (year: ${p.year ?? "—"})`);
  }
  await prisma.$disconnect();
})();
