import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/parent-recommendations?parentId=xxx
 *
 * Returns grouped recommendations per student:
 * (a) Gap-based → focused practice (grouped by subject per student)
 * (b) Upcoming exams → past-year paper practice
 * (c) Daily quiz → general recommendation (grouped across students)
 */

type SubjectGap = { subject: string; topics: string[] };

type Recommendation =
  | {
      type: "focused-gap";
      studentId: string;
      studentName: string;
      studentLevel: number | null;
      gaps: SubjectGap[];
      message: string;
    }
  | {
      type: "exam-coming";
      students: { id: string; name: string; level: number | null }[];
      examType: string;
      message: string;
    }
  | {
      type: "daily-quiz";
      students: { id: string; name: string; level: number | null }[];
      message: string;
    };

export async function GET(req: NextRequest) {
  const parentId = req.nextUrl.searchParams.get("parentId");
  if (!parentId) return NextResponse.json({ recommendations: [] });

  const parent = await prisma.user.findUnique({
    where: { id: parentId },
    select: {
      parentLinks: { include: { student: { select: { id: true, name: true, level: true } } } },
    },
  });
  const linkedStudents = parent?.parentLinks?.map(l => l.student) ?? [];
  if (linkedStudents.length === 0) return NextResponse.json({ recommendations: [] });

  const recommendations: Recommendation[] = [];
  const month = new Date().getMonth() + 1;

  // Collect exam-coming and daily-quiz across students
  const examComingStudents: { id: string; name: string; level: number | null }[] = [];
  const quizStudents: { id: string; name: string; level: number | null }[] = [];

  let examType: string | null = null;
  if (month === 1 || month === 2) examType = "WA1";
  else if (month === 4) examType = "WA2";
  else if (month === 7) examType = "WA3";
  else if (month === 9) examType = "End of Year";

  for (const student of linkedStudents) {
    const studentName = student.name ?? "Student";

    // ─── (a) Check for gaps ───
    const markedPapers = await prisma.examPaper.findMany({
      where: {
        assignedToId: student.id,
        markingStatus: { in: ["complete", "released"] },
        paperType: { not: "focused" },
      },
      select: {
        subject: true,
        questions: {
          select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true },
        },
      },
    });

    const topicPerf: Record<string, Record<string, { earned: number; available: number }>> = {};
    for (const paper of markedPapers) {
      const subj = paper.subject ?? "Unknown";
      if (!topicPerf[subj]) topicPerf[subj] = {};
      for (const q of paper.questions) {
        const topic = q.syllabusTopic ?? "Untagged";
        if (topic === "Untagged" || q.marksAwarded == null || q.marksAvailable == null) continue;
        if (!topicPerf[subj][topic]) topicPerf[subj][topic] = { earned: 0, available: 0 };
        topicPerf[subj][topic].earned += q.marksAwarded;
        topicPerf[subj][topic].available += q.marksAvailable;
      }
    }

    const recentFocused = await prisma.examPaper.findMany({
      where: {
        assignedToId: student.id,
        paperType: "focused",
        createdAt: { gte: new Date(Date.now() - 14 * 86400000) },
      },
      select: { title: true },
    });
    const recentFocusedTopics = new Set(
      recentFocused.map(f => f.title.replace(/^P\d+ Focused: /, "").replace(/^Focused: /, ""))
    );

    // Collect gaps across all subjects for this student
    const gaps: SubjectGap[] = [];
    for (const [subject, topics] of Object.entries(topicPerf)) {
      const weakTopics = Object.entries(topics)
        .filter(([, v]) => v.available > 0 && (v.earned / v.available) < 0.75)
        .filter(([name]) => !recentFocusedTopics.has(name))
        .sort(([, a], [, b]) => (a.earned / a.available) - (b.earned / b.available))
        .map(([name]) => name)
        .slice(0, 3);
      if (weakTopics.length > 0) gaps.push({ subject, topics: weakTopics });
    }

    if (gaps.length > 0) {
      // Build message: "David has gaps in Science: X, Y and Math: Z"
      const gapParts = gaps.map(g => `${g.subject}: ${g.topics.join(", ")}`);
      const message = `${studentName} has gaps in ${gapParts.join(" and ")}. Would you like to create focused practice?`;
      recommendations.push({
        type: "focused-gap",
        studentId: student.id,
        studentName,
        studentLevel: student.level,
        gaps,
        message,
      });
    }

    // ─── (b) Exam coming ───
    if (examType) {
      examComingStudents.push({ id: student.id, name: studentName, level: student.level });
    }

    // ─── (c) Daily quiz — only if no exam and no gaps ───
    if (!examType && gaps.length === 0) {
      quizStudents.push({ id: student.id, name: studentName, level: student.level });
    }
  }

  // Group exam-coming into one recommendation
  if (examType && examComingStudents.length > 0) {
    const names = examComingStudents.map(s => s.name);
    const nameStr = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    recommendations.push({
      type: "exam-coming",
      students: examComingStudents,
      examType,
      message: `${nameStr}'s ${examType} tests are coming up. Would you like to assign a past-year paper for practice?`,
    });
  }

  // Group daily quiz into one recommendation
  if (quizStudents.length > 0) {
    const names = quizStudents.map(s => s.name);
    const nameStr = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    recommendations.push({
      type: "daily-quiz",
      students: quizStudents,
      message: `${nameStr} ${quizStudents.length === 1 ? "is" : "are"} progressing well. A short daily quiz can help refresh and sharpen concepts. Would you like to assign one?`,
    });
  }

  return NextResponse.json({ recommendations });
}
