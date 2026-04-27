import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";

// Debug helper for the print-and-scan flow. Lets us see exactly which
// paper / student a given print code resolves to, plus every other
// student whose id shares the same 8-char prefix (the worry being cuid
// collisions on the timestamp-based first 8 chars).
//
// Pass the code as a query string so it survives the URL-encoding gauntlet:
//   /api/admin/debug-print-routing?code=MFY-abcd1234-efgh5678
// Or just the studentId prefix on its own:
//   /api/admin/debug-print-routing?student=efgh5678
//
// Also accepts ?clone=<paperId> to dump a specific clone's metadata.

export async function GET(request: NextRequest) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({ where: { id: sessionUserId }, select: { name: true } });
  if (me?.name?.toLowerCase() !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const code = request.nextUrl.searchParams.get("code");
  const studentParam = request.nextUrl.searchParams.get("student");
  const cloneId = request.nextUrl.searchParams.get("clone");

  let paperPrefix: string | null = null;
  let studentPrefix: string | null = studentParam;
  if (code) {
    const m = code.match(/^MFY-([A-Za-z0-9]{8})-([A-Za-z0-9]{8})$/);
    if (!m) return NextResponse.json({ error: "code malformed" }, { status: 400 });
    paperPrefix = m[1];
    studentPrefix = m[2];
  }

  const out: Record<string, unknown> = {};

  if (paperPrefix) {
    out.paperMatches = await prisma.examPaper.findMany({
      where: { id: { startsWith: paperPrefix }, sourceExamId: null },
      select: { id: true, title: true, paperType: true, userId: true, createdAt: true },
      take: 10,
    });
  }

  if (studentPrefix) {
    out.studentMatches = await prisma.user.findMany({
      where: { id: { startsWith: studentPrefix } },
      select: { id: true, name: true, role: true, createdAt: true },
      take: 20,
    });
  }

  if (cloneId) {
    const clone = await prisma.examPaper.findUnique({
      where: { id: cloneId },
      select: {
        id: true, title: true, sourceExamId: true, assignedToId: true,
        completedAt: true, score: true, totalMarks: true, markingStatus: true,
        createdAt: true,
      },
    });
    let assignedTo = null;
    if (clone?.assignedToId) {
      assignedTo = await prisma.user.findUnique({
        where: { id: clone.assignedToId },
        select: { id: true, name: true, role: true },
      });
    }
    out.clone = { ...clone, assignedTo };
  }

  // Always include the most recent clones for context (last 5 inbound-email
  // submissions are easy to spot — sourceExamId set, completedAt set).
  out.recentClones = await prisma.examPaper.findMany({
    where: { sourceExamId: { not: null }, completedAt: { not: null } },
    select: {
      id: true, title: true, assignedToId: true, sourceExamId: true,
      completedAt: true, score: true, totalMarks: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return NextResponse.json(out);
}
