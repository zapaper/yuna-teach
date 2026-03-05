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

  // Get all marked papers for this student (clones + focused tests)
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      markingStatus: { in: ["complete", "released"] },
    },
    select: {
      id: true,
      subject: true,
      sourceExamId: true,
      questions: {
        select: {
          questionNum: true,
          syllabusTopic: true,
          marksAwarded: true,
          marksAvailable: true,
        },
      },
    },
  });

  // Collect all source exam IDs so we can look up master question tags
  const sourceIds = papers
    .map((p) => p.sourceExamId)
    .filter((id): id is string => id !== null);

  // Fetch master papers' questions for syllabus topic lookup
  const masterTopics: Record<string, Record<string, string | null>> = {};
  if (sourceIds.length > 0) {
    const masters = await prisma.examPaper.findMany({
      where: { id: { in: sourceIds } },
      select: {
        id: true,
        questions: {
          select: { questionNum: true, syllabusTopic: true },
        },
      },
    });
    for (const m of masters) {
      const topicMap: Record<string, string | null> = {};
      for (const q of m.questions) {
        topicMap[q.questionNum] = q.syllabusTopic;
      }
      masterTopics[m.id] = topicMap;
    }
  }

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

    // For clones, look up syllabusTopic from master if clone's own tag is null
    const masterMap = paper.sourceExamId ? masterTopics[paper.sourceExamId] : null;

    for (const q of paper.questions) {
      const topic = q.syllabusTopic
        || (masterMap ? masterMap[q.questionNum] : null)
        || "Untagged";
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
