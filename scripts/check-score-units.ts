import { prisma } from "../src/lib/db";

async function main() {
  // Sample a few mastery and non-mastery quizzes — see if score
  // looks like a raw-marks number or a percentage.
  const rows = await prisma.examPaper.findMany({
    where: { score: { not: null }, completedAt: { not: null } },
    select: {
      id: true, title: true, paperType: true, score: true,
      questions: { select: { marksAwarded: true, marksAvailable: true } },
    },
    take: 30,
    orderBy: { completedAt: "desc" },
  });
  for (const p of rows) {
    const sumAwarded = p.questions.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
    const sumAvail = p.questions.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    const pct = sumAvail > 0 ? (sumAwarded / sumAvail * 100).toFixed(1) : "—";
    console.log(`  [${p.paperType ?? "—"}] score=${p.score}  sumAwarded=${sumAwarded}  sumAvail=${sumAvail}  pct=${pct}%  title=${p.title.slice(0, 40)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
