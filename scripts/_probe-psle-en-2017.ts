import { prisma } from "../src/lib/db";
async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      AND: [
        { subject: { contains: "english", mode: "insensitive" } },
        { OR: [
          { title: { contains: "2017", mode: "insensitive" } },
          { year: "2017" },
        ] },
        { title: { contains: "PSLE", mode: "insensitive" } },
      ],
    },
    select: {
      id: true, title: true, paperType: true, subject: true,
      sourceExamId: true, pdfPath: true, pageCount: true,
      createdAt: true,
      _count: { select: { questions: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  for (const p of papers) {
    console.log(`${p.createdAt.toISOString().slice(0,10)} ${p.id} type=${p.paperType ?? "master"} pdf=${p.pdfPath ?? "null"} pages=${p.pageCount} qcount=${p._count.questions} title="${p.title}"`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
