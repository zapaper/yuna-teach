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
    orderBy: { completedAt: "asc" },
    select: {
      id: true,
      title: true,
      subject: true,
      sourceExamId: true,
      completedAt: true,
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

  // Helper: resolve topic for a question
  function resolveTopic(
    q: { syllabusTopic: string | null; questionNum: string },
    sourceExamId: string | null
  ): string {
    return (
      q.syllabusTopic ||
      (sourceExamId ? masterTopics[sourceExamId]?.[q.questionNum] : null) ||
      "Untagged"
    );
  }

  // Aggregate by subject → topic
  const subjects: Record<string, {
    examCount: number;
    topics: Record<string, { earned: number; available: number; count: number }>;
  }> = {};

  // Timeline: per subject → array of { title, date, topics: { [topic]: pct } }
  const timeline: Record<string, Array<{
    title: string;
    date: string;
    topics: Record<string, number>;
  }>> = {};

  for (const paper of papers) {
    const subject = paper.subject || "Other";
    if (!subjects[subject]) {
      subjects[subject] = { examCount: 0, topics: {} };
    }
    subjects[subject].examCount++;

    // Per-exam per-topic aggregation for timeline
    const examTopics: Record<string, { earned: number; available: number }> = {};

    for (const q of paper.questions) {
      const topic = resolveTopic(q, paper.sourceExamId);

      // Overall aggregation
      if (!subjects[subject].topics[topic]) {
        subjects[subject].topics[topic] = { earned: 0, available: 0, count: 0 };
      }
      const t = subjects[subject].topics[topic];
      t.earned += q.marksAwarded ?? 0;
      t.available += q.marksAvailable ?? 0;
      t.count++;

      // Per-exam aggregation
      if (!examTopics[topic]) examTopics[topic] = { earned: 0, available: 0 };
      examTopics[topic].earned += q.marksAwarded ?? 0;
      examTopics[topic].available += q.marksAvailable ?? 0;
    }

    // Convert to percentages for timeline
    const topicPcts: Record<string, number> = {};
    for (const [topic, td] of Object.entries(examTopics)) {
      if (topic === "Untagged") continue;
      topicPcts[topic] = td.available > 0 ? Math.round((td.earned / td.available) * 100) : 0;
    }

    if (Object.keys(topicPcts).length > 0) {
      if (!timeline[subject]) timeline[subject] = [];
      timeline[subject].push({
        title: paper.title,
        date: paper.completedAt?.toISOString() ?? "",
        topics: topicPcts,
      });
    }
  }

  return NextResponse.json({ student, subjects, timeline });
}
