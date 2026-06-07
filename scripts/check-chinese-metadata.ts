import { prisma } from "../src/lib/db";

const CHINESE_PAPERS = [
  { year: "2025", id: "cmphn6npc000112g1sdstau5j" },
  { year: "2018", id: "cmphqacp9000198jkrd6ambui" },
  { year: "2016", id: "cmphqli6g002b98jke0olegzj" },
];

async function main() {
  for (const { year, id } of CHINESE_PAPERS) {
    const p = await prisma.examPaper.findUnique({
      where: { id },
      select: { pageCount: true, metadata: true },
    });
    if (!p?.metadata) continue;
    const meta = p.metadata as Record<string, unknown>;
    console.log(`\n=== ${year} (${p.pageCount} pages total) ===`);
    console.log(`  papers: ${JSON.stringify(meta.papers)}`);
    console.log(`  skipPages: ${JSON.stringify(meta.skipPages)}`);
    console.log(`  coverPages: ${JSON.stringify(meta.coverPages)}`);
    console.log(`  passagePages: ${JSON.stringify(meta.passagePages)}`);
    console.log(`  answerPages: ${JSON.stringify(meta.answerPages)}`);
    console.log(`  validationIssues: ${JSON.stringify(meta.validationIssues)?.slice(0, 200)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
