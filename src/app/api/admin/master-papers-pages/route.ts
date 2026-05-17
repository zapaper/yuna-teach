import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";

// Returns the list of MASTER ExamPapers (sourceExamId IS NULL,
// paperType IS NULL) along with id / title / pageCount. The admin
// remask-watermarks page uses this to drive a per-paper loop —
// firing /api/exam/[id]/remask-watermark once per id.
export async function GET() {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { name: true, settings: true },
  });
  if (!isAdmin(me)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null, paperType: null },
    select: { id: true, title: true, subject: true, pageCount: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ papers });
}
