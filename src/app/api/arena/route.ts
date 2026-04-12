import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const studentId = request.nextUrl.searchParams.get("studentId");
  if (!studentId) return NextResponse.json({ error: "studentId required" }, { status: 400 });

  // Get current week's Monday 00:00
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);

  // Find all students with pvp enabled
  const pvpStudents = await prisma.user.findMany({
    where: { role: "STUDENT" },
    select: { id: true, name: true, settings: true },
  });
  const arenaStudents = pvpStudents.filter(s => {
    const settings = s.settings as Record<string, unknown> | null;
    return settings?.pvp === true;
  });

  if (arenaStudents.length === 0) {
    return NextResponse.json({ leaderboard: [], playerRank: null, playerEntry: null });
  }

  const studentIds = arenaStudents.map(s => s.id);

  // Get this week's completed papers for all arena students
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: studentIds },
      completedAt: { gte: monday },
    },
    select: {
      assignedToId: true,
      score: true,
      totalMarks: true,
    },
  });

  // Aggregate per student
  const stats: Record<string, { name: string; points: number; totalMarks: number; earned: number }> = {};
  for (const s of arenaStudents) {
    stats[s.id] = { name: s.name, points: 0, totalMarks: 0, earned: 0 };
  }
  for (const p of papers) {
    if (!p.assignedToId || !stats[p.assignedToId]) continue;
    const score = p.score ?? 0;
    const total = p.totalMarks ? parseFloat(p.totalMarks) : 0;
    stats[p.assignedToId].points += score;
    stats[p.assignedToId].earned += score;
    stats[p.assignedToId].totalMarks += total;
  }

  // Build leaderboard sorted by points desc
  const leaderboard = Object.entries(stats)
    .map(([id, s]) => ({
      id,
      name: s.name,
      points: s.points,
      pct: s.totalMarks > 0 ? Math.round((s.earned / s.totalMarks) * 100) : 0,
    }))
    .sort((a, b) => b.points - a.points);

  // Top 10
  const top10 = leaderboard.slice(0, 10);

  // Find player's rank
  const playerIdx = leaderboard.findIndex(e => e.id === studentId);
  const playerRank = playerIdx >= 0 ? playerIdx + 1 : null;
  const playerEntry = playerIdx >= 0 ? leaderboard[playerIdx] : null;

  return NextResponse.json({
    leaderboard: top10,
    playerRank,
    playerEntry: playerIdx >= 10 ? playerEntry : null, // only include if not in top 10
  });
}
