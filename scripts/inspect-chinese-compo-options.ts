import { prisma } from "../src/lib/db";
async function main() {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: { status: "ready" },
    orderBy: { year: "asc" },
    select: { year: true, compoOption1Topic: true, compoOption1Model: true, compoOption2: true, compoOption2Model: true },
  });
  console.log(`Years: ${rows.length}\n`);
  for (const r of rows) {
    const opt2 = r.compoOption2 as { instructions?: string; helpingWords?: string[] } | null;
    console.log(`[${r.year}]`);
    console.log(`  Option 1 题目: ${r.compoOption1Topic ?? "(无)"}`);
    console.log(`  Option 1 model: ${r.compoOption1Model ? r.compoOption1Model.length + " chars" : "—"}`);
    console.log(`  Option 2 instructions: ${opt2?.instructions ?? "(无)"}`);
    console.log(`  Option 2 帮助词: ${opt2?.helpingWords?.join("、") ?? "(无)"}`);
    console.log(`  Option 2 model: ${r.compoOption2Model ? r.compoOption2Model.length + " chars" : "—"}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
