import { prisma } from "../src/lib/db";
async function main() {
  const subjects = await prisma.examPaper.findMany({
    where: { paperType: null, sourceExamId: null },
    select: { subject: true },
  });
  const counts = new Map<string, number>();
  for (const s of subjects) {
    const k = s.subject ?? "(null)";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...counts.entries()].sort((a,b)=>b[1]-a[1])) {
    console.log(`${v.toString().padStart(4)} × "${k}"`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
