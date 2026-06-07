import { prisma } from "../src/lib/db";
async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: "Mathematics",
      title: { contains: "PSLE", mode: "insensitive" },
    },
    select: {
      id: true,
      title: true,
      year: true,
      level: true,
      _count: { select: { questions: true } },
    },
    orderBy: { year: "desc" },
    take: 60,
  });
  console.log(JSON.stringify(papers, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
