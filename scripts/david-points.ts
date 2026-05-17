import { prisma } from "../src/lib/db";

(async () => {
  const ID = "cmm5wf91d000ryrxwaddlo6xh";
  const u = await prisma.user.findUnique({ where: { id: ID }, select: { name: true, settings: true } });
  if (!u) { console.error("not found"); process.exit(1); }
  const settings = (u.settings as Record<string, unknown>) ?? {};
  const bonusPoints = (settings.bonusPoints as number | undefined) ?? 0;
  const arenaBonus = (settings.arenaBonusPoints as number | undefined) ?? 0;

  // Total points (habitat unlocks): sum of completed-paper scores (skip
  // revision papers — they're a recap of past mistakes) + bonusPoints.
  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: ID, completedAt: { not: null } },
    select: { score: true, totalMarks: true, metadata: true, completedAt: true, title: true },
  });
  const realPapers = papers.filter(p => {
    const meta = p.metadata as { revisionMode?: string } | null;
    return !meta?.revisionMode;
  });
  const earned = realPapers.reduce((s, p) => s + (p.score ?? 0), 0);
  const totalPoints = earned + bonusPoints;

  // Arena (this week, since Monday 00:00 local).
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  const weekly = realPapers.filter(p => p.completedAt && p.completedAt >= monday);
  const weeklyEarned = weekly.reduce((s, p) => s + (p.score ?? 0), 0);
  const arenaPoints = weeklyEarned + arenaBonus;

  console.log(`${u.name}`);
  console.log(`  Habitat totalPoints:       ${earned} (papers) + ${bonusPoints} (bonus) = ${totalPoints}`);
  console.log(`  Arena weekly points:       ${weeklyEarned} (papers since ${monday.toLocaleString()}) + ${arenaBonus} (arenaBonus) = ${arenaPoints}`);
  console.log(`  Completed real papers:     ${realPapers.length}`);
  console.log(`  Of which this week:        ${weekly.length}`);
  console.log(`  Settings.pvp:              ${settings.pvp}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
