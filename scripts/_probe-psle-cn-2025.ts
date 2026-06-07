import { prisma } from "../src/lib/db";
async function main() {
  // Find PSLE Chinese 2025 papers and any clones.
  const papers = await prisma.examPaper.findMany({
    where: { title: { contains: "PSLE Chinese 2025", mode: "insensitive" } },
    select: {
      id: true, title: true, paperType: true,
      sourceExamId: true, pdfPath: true, assignedToId: true,
      assignedTo: { select: { name: true } },
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  for (const p of papers) {
    console.log(`${p.createdAt.toISOString().slice(0,16)} ${p.id}`);
    console.log(`  title="${p.title}" type=${p.paperType ?? "(master)"}`);
    console.log(`  pdf=${p.pdfPath ?? "null"} src=${p.sourceExamId ?? "null"} student=${p.assignedTo?.name ?? "—"}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
