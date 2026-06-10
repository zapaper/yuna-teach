// Lightweight count of marker problems for the AdminNav badge.
// Returns { stuck, failed } — cheaper than the full dashboard
// endpoint because it doesn't aggregate hourly buckets or pull
// titles/owners. Polled by AdminNav every 60s.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// Same threshold the dashboard uses — keep the badge and the
// dashboard's "Stuck" section in lockstep.
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

const EXCLUDED_NAMES = new Set(["admin", "student555", "student666"]);

export async function GET() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Excluded user ids — same logic as the dashboard.
  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true, settings: true },
  });
  const excludedIds: string[] = [];
  for (const u of allUsers) {
    const lower = (u.name ?? "").toLowerCase();
    if (lower === "admin" || EXCLUDED_NAMES.has(lower)) { excludedIds.push(u.id); continue; }
    const s = u.settings as { admin?: unknown } | null;
    if (s?.admin === true) excludedIds.push(u.id);
  }

  // 14d window — matches the dashboard's WINDOW_DAYS.
  const since7d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const stuckBefore = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const userScope = excludedIds.length > 0 ? {
    AND: [
      { userId: { notIn: excludedIds } },
      { OR: [{ assignedToId: null }, { assignedToId: { notIn: excludedIds } }] },
    ],
  } : {};

  const [failed, stuck] = await Promise.all([
    prisma.examPaper.count({
      where: {
        markingStatus: "failed",
        completedAt: { gte: since7d },
        paperType: { not: "eval" },
        ...userScope,
      },
    }),
    prisma.examPaper.count({
      where: {
        markingStatus: "in_progress",
        completedAt: { gte: since7d, lt: stuckBefore },
        paperType: { not: "eval" },
        ...userScope,
      },
    }),
  ]);

  return NextResponse.json({ failed, stuck });
}
