import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/parent-recommendations?parentId=xxx
 *
 * Returns smart recommendations for a parent based on:
 * (a) Student gaps → suggest focused practice
 * (b) Upcoming exams by month → suggest past-year paper practice
 * (c) General → suggest daily quiz
 */

type Recommendation = {
  type: "focused-gap" | "exam-coming" | "daily-quiz";
  studentId: string;
  studentName: string;
  studentLevel: number | null;
  message: string;
  /** For focused-gap: the weak topics */
  topics?: string[];
  subject?: string;
  /** For exam-coming: the exam type */
  examType?: string;
};

export async function GET(req: NextRequest) {
  const parentId = req.nextUrl.searchParams.get("parentId");
  if (!parentId) return NextResponse.json({ recommendations: [] });

  // Get linked students
  const parent = await prisma.user.findUnique({
    where: { id: parentId },
    select: {
      parentLinks: { include: { student: { select: { id: true, name: true, level: true } } } },
    },
  });
  const linkedStudents = parent?.parentLinks?.map(l => l.student) ?? [];
  if (linkedStudents.length === 0) return NextResponse.json({ recommendations: [] });

  const recommendations: Recommendation[] = [];
  const month = new Date().getMonth() + 1; // 1-12

  for (const student of linkedStudents) {
    const studentName = student.name ?? "Student";

    // ─── (a) Check for gaps needing focused practice ───
    // Get marked papers for this student
    const markedPapers = await prisma.examPaper.findMany({
      where: {
        assignedToId: student.id,
        markingStatus: { in: ["complete", "released"] },
        paperType: { not: "focused" }, // don't loop on focused tests
      },
      select: {
        subject: true,
        questions: {
          select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true },
        },
      },
    });

    // Aggregate topic performance
    const topicPerf: Record<string, Record<string, { earned: number; available: number }>> = {};
    for (const paper of markedPapers) {
      const subj = paper.subject ?? "Unknown";
      if (!topicPerf[subj]) topicPerf[subj] = {};
      for (const q of paper.questions) {
        const topic = q.syllabusTopic ?? "Untagged";
        if (topic === "Untagged") continue;
        if (q.marksAwarded == null || q.marksAvailable == null) continue;
        if (!topicPerf[subj][topic]) topicPerf[subj][topic] = { earned: 0, available: 0 };
        topicPerf[subj][topic].earned += q.marksAwarded;
        topicPerf[subj][topic].available += q.marksAvailable;
      }
    }

    // Check for recent focused tests on weak topics
    const recentFocused = await prisma.examPaper.findMany({
      where: {
        assignedToId: student.id,
        paperType: "focused",
        createdAt: { gte: new Date(Date.now() - 14 * 86400000) }, // last 14 days
      },
      select: { title: true },
    });
    const recentFocusedTopics = new Set(
      recentFocused.map(f => f.title.replace(/^P\d+ Focused: /, "").replace(/^Focused: /, ""))
    );

    // Find weak topics (< 60%) without recent focused practice
    for (const [subject, topics] of Object.entries(topicPerf)) {
      const weakTopics = Object.entries(topics)
        .filter(([, v]) => v.available > 0 && (v.earned / v.available) < 0.75)
        .filter(([name]) => !recentFocusedTopics.has(name))
        .sort(([, a], [, b]) => (a.earned / a.available) - (b.earned / b.available))
        .map(([name]) => name)
        .slice(0, 3);

      if (weakTopics.length > 0) {
        recommendations.push({
          type: "focused-gap",
          studentId: student.id,
          studentName,
          studentLevel: student.level,
          subject,
          topics: weakTopics,
          message: `${studentName} has some gaps in ${weakTopics.join(", ")}. Would you like to create focused practice in these areas?`,
        });
      }
    }

    // ─── (b) Upcoming exam recommendations ───
    // WA1: end-Feb (recommend Jan-Feb), WA2: early-May (recommend Apr),
    // WA3: early-Aug (recommend Jul), Finals: Oct (recommend Sep)
    let examType: string | null = null;
    if (month === 1 || month === 2) examType = "WA1";
    else if (month === 4) examType = "WA2";
    else if (month === 7) examType = "WA3";
    else if (month === 9) examType = "End of Year";

    if (examType) {
      recommendations.push({
        type: "exam-coming",
        studentId: student.id,
        studentName,
        studentLevel: student.level,
        examType,
        message: `${studentName}'s ${examType} tests are coming up. Would you like to assign a past-year paper for practice?`,
      });
    }

    // ─── (c) Daily quiz recommendation ───
    // Only if no exam coming up and no critical gaps
    if (!examType && recommendations.filter(r => r.studentId === student.id && r.type === "focused-gap").length === 0) {
      recommendations.push({
        type: "daily-quiz",
        studentId: student.id,
        studentName,
        studentLevel: student.level,
        message: `${studentName} is progressing well. A daily short quiz can refresh and sharpen their concepts. Would you like to assign one?`,
      });
    }
  }

  return NextResponse.json({ recommendations });
}
