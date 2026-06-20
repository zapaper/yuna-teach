import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/admin/users
//
// Returns parents and students separately, each with their linked
// counterpart accounts (parents -> students, students -> parents).
// Admin-only.

export async function GET() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 14-day signup series for the chart at the top of /admin/users.
  // Daily new-user counts (PARENT + STUDENT combined) bucketed in SGT
  // so the X-axis matches local clock-time. Cumulative is total users
  // alive on the END of that day (covers all roles, no role filter).
  const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
  const DAYS = 14;
  const nowMs = Date.now();
  const todaySgt = new Date(nowMs + SGT_OFFSET_MS);
  todaySgt.setUTCHours(0, 0, 0, 0);
  const startSgt = new Date(todaySgt.getTime() - (DAYS - 1) * 24 * 60 * 60 * 1000);
  const startMsUtc = startSgt.getTime() - SGT_OFFSET_MS;
  const [allCreatedAt, totalBefore] = await Promise.all([
    prisma.user.findMany({
      where: { createdAt: { gte: new Date(startMsUtc) } },
      select: { createdAt: true },
    }),
    prisma.user.count({ where: { createdAt: { lt: new Date(startMsUtc) } } }),
  ]);
  const buckets: Record<string, number> = {};
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(startSgt.getTime() + i * 24 * 60 * 60 * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    buckets[key] = 0;
  }
  for (const u of allCreatedAt) {
    const sgt = new Date(u.createdAt.getTime() + SGT_OFFSET_MS);
    sgt.setUTCHours(0, 0, 0, 0);
    const key = `${sgt.getUTCFullYear()}-${String(sgt.getUTCMonth() + 1).padStart(2, "0")}-${String(sgt.getUTCDate()).padStart(2, "0")}`;
    if (buckets[key] !== undefined) buckets[key]++;
  }
  let cum = totalBefore;
  const signups14d: { date: string; newUsers: number; cumulative: number }[] = [];
  for (const key of Object.keys(buckets)) {
    cum += buckets[key];
    signups14d.push({ date: key, newUsers: buckets[key], cumulative: cum });
  }

  const [parents, students] = await Promise.all([
    prisma.user.findMany({
      where: { role: "PARENT" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        email: true,
        createdAt: true,
        lastLoginAt: true,
        settings: true,
        parentLinks: {
          select: {
            student: {
              select: {
                id: true,
                name: true,
                displayName: true,
                level: true,
                _count: { select: { examPapers: true } },
              },
            },
          },
        },
        _count: { select: { examPapers: true } },
      },
    }),
    prisma.user.findMany({
      where: { role: "STUDENT" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        email: true,
        level: true,
        createdAt: true,
        lastLoginAt: true,
        settings: true,
        studentLinks: {
          select: { parent: { select: { id: true, name: true, displayName: true, email: true } } },
        },
        _count: { select: { assignedExamPapers: true } },
      },
    }),
  ]);

  return NextResponse.json({
    signups14d,
    parents: parents.map(p => ({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      email: p.email,
      createdAt: p.createdAt.toISOString(),
      lastLoginAt: p.lastLoginAt?.toISOString() ?? null,
      isAdmin: ((p.settings as { admin?: unknown } | null)?.admin === true) || p.name?.toLowerCase() === "admin",
      // Total papers in this family: parent-assigned (parent.examPapers,
      // owned by parent) + each linked student's self-assigned/uploaded
      // papers (student.examPapers, owned by the student). Disjoint
      // sets — a parent-assigned paper has userId=parent, a self-
      // assigned one has userId=student — so summing is safe.
      paperCount:
        p._count.examPapers +
        p.parentLinks.reduce((sum, l) => sum + l.student._count.examPapers, 0),
      students: p.parentLinks.map(l => ({
        id: l.student.id,
        name: l.student.name,
        displayName: l.student.displayName,
        level: l.student.level,
      })),
    })),
    students: students.map(s => {
      // Surface progress-email "already sent" subjects so the admin
      // panel can show a green badge per subject the family has
      // received a one-time report for.
      const sentMap = (s.settings as { progressReportsSent?: Record<string, string> } | null)?.progressReportsSent ?? {};
      const progressEmailsSent = Object.entries(sentMap).map(([subjectKey, sentAt]) => ({ subjectKey, sentAt }));
      return {
        id: s.id,
        name: s.name,
        displayName: s.displayName,
        email: s.email,
        level: s.level,
        createdAt: s.createdAt.toISOString(),
        lastLoginAt: s.lastLoginAt?.toISOString() ?? null,
        paperCount: s._count.assignedExamPapers,
        parents: s.studentLinks.map(l => l.parent),
        progressEmailsSent,
      };
    }),
  });
}
