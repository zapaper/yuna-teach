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
        studentLinks: {
          select: { parent: { select: { id: true, name: true, displayName: true, email: true } } },
        },
        _count: { select: { assignedExamPapers: true } },
      },
    }),
  ]);

  return NextResponse.json({
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
    students: students.map(s => ({
      id: s.id,
      name: s.name,
      displayName: s.displayName,
      email: s.email,
      level: s.level,
      createdAt: s.createdAt.toISOString(),
      lastLoginAt: s.lastLoginAt?.toISOString() ?? null,
      paperCount: s._count.assignedExamPapers,
      parents: s.studentLinks.map(l => l.parent),
    })),
  });
}
