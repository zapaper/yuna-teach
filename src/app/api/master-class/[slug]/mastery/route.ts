import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { getMasteryReport } from "@/lib/master-class/mastery";

// GET /api/master-class/[slug]/mastery?studentId=...
// Returns the per-sub-topic mastery state for the given student on
// this master class, plus a list of weakest sub-topic IDs (max 3)
// for the focused-quiz CTA.
//
// Auth: session must be the student themselves, an admin, or a
// parent linked to the student.
export async function GET(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const studentId = req.nextUrl.searchParams.get("studentId");
  if (!studentId) return NextResponse.json({ error: "studentId required" }, { status: 400 });

  // Authz: self, admin, or linked parent.
  if (sessionUserId !== studentId) {
    const me = await prisma.user.findUnique({
      where: { id: sessionUserId },
      select: { name: true, settings: true },
    });
    if (!isAdmin(me)) {
      const link = await prisma.parentStudent.findUnique({
        where: { parentId_studentId: { parentId: sessionUserId, studentId } },
      });
      if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { slug } = await context.params;
  const report = await getMasteryReport(slug, studentId);
  return NextResponse.json(report);
}
