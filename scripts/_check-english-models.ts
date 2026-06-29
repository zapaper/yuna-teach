import { prisma } from "@/lib/db";

async function main() {
  const papers = await prisma.englishSupplementaryPaper.findMany({
    where: { continuousModel: { not: null } },
    select: { year: true, continuousTheme: true, continuousModel: true },
    orderBy: { year: "desc" },
  });
  console.log(`Papers with continuousModel: ${papers.length}\n`);
  let totalEssays = 0;
  for (const p of papers) {
    const txt = p.continuousModel ?? "";
    const essays = txt.split(/\n\s*---\s*\n/).map(e => e.trim()).filter(e => e.length > 200);
    totalEssays += essays.length;
    console.log(`  ${p.year}  theme="${p.continuousTheme ?? "?"}"  essays=${essays.length}  totalChars=${txt.length}`);
  }
  console.log(`\nTotal essays available: ${totalEssays}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
