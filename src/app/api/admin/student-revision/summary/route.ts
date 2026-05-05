import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";
import { analyseStudentMistakes } from "@/lib/revision";

// GET /api/admin/student-revision/summary?studentId=<id>
//
// Returns per-subject mistake stats for a student across their last
// 100 completed papers. Powers the parent-dashboard "Revise work"
// modal's initial render.
//
// Now open to: admin, the student themselves, or any parent linked
// to the student via parent_students. (The path still says /admin/
// because the routes were originally admin-gated; left in place to
// avoid breaking the URL the modal already calls.)

export async function GET(request: NextRequest) {
  const studentId = request.nextUrl.searchParams.get("studentId");
  if (!studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const isAdmin = await isSessionAdmin();
  if (!isAdmin) {
    if (sessionUserId !== studentId) {
      const link = await prisma.parentStudent.findUnique({
        where: { parentId_studentId: { parentId: sessionUserId, studentId } },
        select: { id: true },
      });
      if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  try {
    const summary = await analyseStudentMistakes(studentId);
    return NextResponse.json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "summary failed";
    if (msg === "student not found") return NextResponse.json({ error: msg }, { status: 404 });
    console.error(`[student-revision/summary] ${studentId}:`, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
