// Find recent Science papers where Q1-28 marks aren't all 2.
// Helps narrow down which papers slipped past the auto-default.
import { prisma } from "../src/lib/db";

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null, paperType: null,
      subject: { contains: "science", mode: "insensitive" },
      createdAt: { gt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }, // last 14 days
    },
    select: {
      id: true, title: true, year: true, createdAt: true, metadata: true,
      questions: {
        select: { questionNum: true, marksAvailable: true },
        where: {},
      },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  console.log(`Inspecting ${papers.length} recent Science papers (last 14 days)\n`);
  for (const p of papers) {
    const md = p.metadata as { papers?: Array<{ label?: string; questionPrefix?: string }> } | null;
    const labels = (md?.papers ?? []).map(x => x.label ?? "").join(" | ");
    const q1_28 = p.questions.filter(q => {
      const n = parseInt(q.questionNum.replace(/^[A-Za-z]+\d*[-:_]?/, ""), 10);
      return Number.isFinite(n) && n >= 1 && n <= 28;
    });
    if (q1_28.length === 0) continue;
    const nullCount = q1_28.filter(q => q.marksAvailable == null).length;
    const twoCount = q1_28.filter(q => q.marksAvailable === 2).length;
    const otherCount = q1_28.length - nullCount - twoCount;
    const flag = nullCount > 0 ? "⚠️" : (twoCount === q1_28.length ? "✓ " : "??");
    console.log(`${flag} [${p.year}] ${p.id} ${p.title.slice(0, 40)}`);
    console.log(`     created ${p.createdAt.toISOString().slice(0, 10)}  metadata.papers labels: "${labels}"`);
    console.log(`     Q1-28 marks: ${twoCount}× 2, ${nullCount}× null, ${otherCount}× other (${q1_28.length} total)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
