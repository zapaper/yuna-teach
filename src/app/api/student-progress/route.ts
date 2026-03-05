import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const parentId = request.nextUrl.searchParams.get("parentId");
  const studentId = request.nextUrl.searchParams.get("studentId");

  if (!parentId || !studentId) {
    return NextResponse.json({ error: "Missing parentId or studentId" }, { status: 400 });
  }

  // Verify parent-student link
  const link = await prisma.parentStudent.findFirst({
    where: { parentId, studentId },
  });
  if (!link) {
    return NextResponse.json({ error: "Not linked" }, { status: 403 });
  }

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, name: true },
  });

  // Get all marked papers for this student uploaded by this parent
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      userId: parentId,
      markingStatus: { in: ["complete", "released"] },
    },
    select: {
      id: true,
      subject: true,
      questions: {
        select: {
          syllabusTopic: true,
          marksAwarded: true,
          marksAvailable: true,
        },
      },
    },
  });

  // Aggregate by subject → topic
  const subjects: Record<string, {
    examCount: number;
    topics: Record<string, { earned: number; available: number; count: number }>;
  }> = {};

  for (const paper of papers) {
    const subject = paper.subject || "Other";
    if (!subjects[subject]) {
      subjects[subject] = { examCount: 0, topics: {} };
    }
    subjects[subject].examCount++;

    for (const q of paper.questions) {
      const topic = q.syllabusTopic || "Untagged";
      if (!subjects[subject].topics[topic]) {
        subjects[subject].topics[topic] = { earned: 0, available: 0, count: 0 };
      }
      const t = subjects[subject].topics[topic];
      t.earned += q.marksAwarded ?? 0;
      t.available += q.marksAvailable ?? 0;
      t.count++;
    }
  }

  return NextResponse.json({ student, subjects });
}
