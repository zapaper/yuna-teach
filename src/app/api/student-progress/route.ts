import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAccessToStudent } from "@/lib/auth-guard";
import { DEMO_DATA_REDIRECT } from "@/lib/tutor";

// Normalise the messy paper.subject strings into the canonical
// bucket labels used everywhere else in the app. Without this, any
// case difference (e.g. "science" vs "Science"), prefix ("P5
// Science"), or null subject produced its own bucket — the parent
// dashboard would show e.g. "Math", "Science", "English" AND "Other"
// with the science-tagged questions of the last bucket bleeding
// into "Other". Mirrors the helper in src/lib/revision.ts so both
// paths classify the same way. Chinese added now that the Chinese
// fork ships — previously its papers fell into "Other".
function bucketSubject(raw: string | null | undefined): "Math" | "Science" | "English" | "Chinese" | "Other" {
  const lower = (raw ?? "").toLowerCase();
  if (lower.includes("math")) return "Math";
  if (lower.includes("science") || lower.includes("sci")) return "Science";
  if (lower.includes("english") || lower.includes("eng")) return "English";
  if (lower.includes("chinese") || raw?.includes("华文") || raw?.includes("中文") || raw?.includes("华语")) return "Chinese";
  return "Other";
}

export async function GET(request: NextRequest) {
  const studentId = request.nextUrl.searchParams.get("studentId");
  if (!studentId) {
    return NextResponse.json({ error: "Missing studentId" }, { status: 400 });
  }

  // Caller comes from the session cookie. requireAccessToStudent
  // verifies the caller is the student, a parent linked to them,
  // or an admin — so the old ?parentId= query param (spoofable)
  // is no longer needed.
  const auth = await requireAccessToStudent(studentId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, name: true },
  });

  // Demo redirect — student67 / student666 borrow david-lim's papers
  // for the progress report so the demo recording has a kid with a
  // full history of attempts. The displayed `student` stays as the
  // requested id+name (so the page header reads "Student67's
  // progress"); only the paper aggregate is swapped.
  const redirect = DEMO_DATA_REDIRECT[studentId] ?? null;
  const dataStudentId = redirect?.sourceStudentId ?? studentId;

  // Get all marked papers for this student (clones + focused tests).
  // Revision papers (metadata.revisionMode set) are filtered out
  // below — they're a curated set of the student's past mistakes,
  // so counting them here would double-count those mistakes and
  // make weak-topic averages drop artificially.
  const allPapers = await prisma.examPaper.findMany({
    where: {
      assignedToId: dataStudentId,
      markingStatus: { in: ["complete", "released"] },
    },
    orderBy: { completedAt: "asc" },
    select: {
      id: true,
      title: true,
      subject: true,
      sourceExamId: true,
      completedAt: true,
      metadata: true,
      questions: {
        select: {
          questionNum: true,
          syllabusTopic: true,
          marksAwarded: true,
          marksAvailable: true,
          studentAnswer: true,
        },
      },
    },
  });
  const papers = allPapers.filter((p) => {
    const meta = p.metadata as { revisionMode?: string } | null;
    return !meta?.revisionMode;
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

  // Timeline: per subject → array of per-paper entries. Each entry now
  // carries both the per-paper pct (back-compat for any consumer reading
  // numbers directly) AND the underlying earned/available so the chart
  // can aggregate mark-weighted across grouped papers — matching the
  // formula used everywhere else (parent dashboard's Skill Profile
  // Analysis, progress page per-topic detail, generateSubjectSummary).
  const timeline: Record<string, Array<{
    title: string;
    date: string;
    topics: Record<string, number>;
    topicTotals: Record<string, { earned: number; available: number }>;
  }>> = {};

  for (const paper of papers) {
    const subject = bucketSubject(paper.subject);
    if (!subjects[subject]) {
      subjects[subject] = { examCount: 0, topics: {} };
    }
    subjects[subject].examCount++;

    // Per-exam per-topic aggregation for timeline
    const examTopics: Record<string, { earned: number; available: number }> = {};

    for (const q of paper.questions) {
      // Skipped questions don't count toward either the numerator or
      // the denominator — they distort the average when included.
      // /api/exam already subtracts skipped marks from the headline
      // score-vs-total ratio (see exam route's skippedMarks lookup);
      // this mirrors the same idea at the per-topic level so the
      // chart / Full Report / progress email all agree.
      if (q.studentAnswer === "__SKIPPED__") continue;
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
    const topicTotals: Record<string, { earned: number; available: number }> = {};
    for (const [topic, td] of Object.entries(examTopics)) {
      if (topic === "Untagged") continue;
      topicPcts[topic] = td.available > 0 ? Math.round((td.earned / td.available) * 100) : 0;
      topicTotals[topic] = { earned: td.earned, available: td.available };
    }

    if (Object.keys(topicPcts).length > 0) {
      if (!timeline[subject]) timeline[subject] = [];
      timeline[subject].push({
        title: paper.title,
        date: paper.completedAt?.toISOString() ?? "",
        topics: topicPcts,
        topicTotals,
      });
    }
  }

  return NextResponse.json({ student, subjects, timeline });
}
