import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAccessToStudent } from "@/lib/auth-guard";

// Cheap counterpart to the main /api/tutor/[studentId] route — returns
// just the current marked-paper count for the subject so the Lumi page
// can detect "kid has done N more quizzes since the cached diagnosis"
// without re-running the full diagnosis aggregation.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const { studentId } = await params;
  const subject = (request.nextUrl.searchParams.get("subject") ?? "Science").toLowerCase();

  const auth = await requireAccessToStudent(studentId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const subjectFilter =
    subject === "math"
      ? { OR: [{ subject: { contains: "math", mode: "insensitive" as const } }] }
      : subject === "chinese"
        ? { OR: [
            { subject: { contains: "chinese", mode: "insensitive" as const } },
            { subject: { contains: "华文" } },
            { subject: { contains: "中文" } },
          ] }
        : { subject: { contains: subject, mode: "insensitive" as const } };

  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      markingStatus: { in: ["complete", "released"] },
      ...subjectFilter,
    },
    select: { metadata: true },
  });
  const paperCount = papers.filter(p => !(p.metadata as { revisionMode?: unknown } | null)?.revisionMode).length;
  return NextResponse.json({ paperCount });
}
