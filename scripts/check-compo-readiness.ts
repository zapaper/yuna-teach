import { prisma } from "../src/lib/db";

async function main() {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    orderBy: { year: "desc" },
    select: {
      year: true, status: true, pdfPath: true,
      compoOption1Topic: true, compoOption2: true,
      compoOption1Model: true, compoOption2Model: true,
    },
  });
  console.log(`Found ${rows.length} rows\n`);
  console.log("year\tstatus\thasPdf\to1Topic\to2Pic\to1Model\to2Model");
  for (const r of rows) {
    const o2 = r.compoOption2 as { picturePageNum?: number } | null;
    console.log([
      r.year,
      r.status,
      r.pdfPath ? "Y" : "N",
      r.compoOption1Topic ? `"${r.compoOption1Topic.slice(0, 20)}…"` : "—",
      o2?.picturePageNum ?? "—",
      r.compoOption1Model ? `${r.compoOption1Model.length}ch` : "—",
      r.compoOption2Model ? `${r.compoOption2Model.length}ch` : "—",
    ].join("\t"));
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
