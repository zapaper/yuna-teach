import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 60000 } });
  return _ai;
}

type SubjectGap = { subject: string; topics: string[] };

type Action =
  | { type: "focused-gap"; studentId: string; studentName: string; studentLevel: number | null; gaps: SubjectGap[] }
  | { type: "exam-coming"; students: { id: string; name: string; level: number | null }[]; examType: string }
  | { type: "daily-quiz"; students: { id: string; name: string; level: number | null }[] };

export async function GET(req: NextRequest) {
  const parentId = req.nextUrl.searchParams.get("parentId");
  const clientHour = parseInt(req.nextUrl.searchParams.get("hour") ?? "-1", 10);
  if (!parentId) return NextResponse.json({ greeting: "", actions: [] });

  const parent = await prisma.user.findUnique({
    where: { id: parentId },
    select: {
      name: true,
      parentLinks: { include: { student: { select: { id: true, name: true, level: true } } } },
    },
  });
  const parentName = parent?.name ?? "there";
  const linkedStudents = parent?.parentLinks?.map(l => l.student) ?? [];
  if (linkedStudents.length === 0) return NextResponse.json({ greeting: "", actions: [] });

  const actions: Action[] = [];
  const month = new Date().getMonth() + 1;
  const dayOfWeek = new Date().toLocaleDateString("en-SG", { weekday: "long" });

  // Exam schedule context
  let examType: string | null = null;
  let examContext = "";
  if (month === 1 || month === 2) { examType = "WA1"; examContext = "WA1 tests are typically at end of February."; }
  else if (month === 4) { examType = "WA2"; examContext = "WA2 tests are typically in early May."; }
  else if (month === 7) { examType = "WA3"; examContext = "WA3 tests are typically in early August."; }
  else if (month === 9) { examType = "End of Year"; examContext = "End-of-year exams are typically in October."; }

  const examComingStudents: { id: string; name: string; level: number | null }[] = [];
  const quizStudents: { id: string; name: string; level: number | null }[] = [];
  const studentSummaries: string[] = [];

  await Promise.all(linkedStudents.map(async (student) => {
    const studentName = student.name ?? "Student";
    const levelStr = student.level ? `Primary ${student.level}` : "";

    // Run all 3 DB queries for this student in parallel
    const [markedPapers, recentFocused, recentQuizCount] = await Promise.all([
      prisma.examPaper.findMany({
        where: {
          assignedToId: student.id,
          markingStatus: { in: ["complete", "released"] },
          paperType: { not: "focused" },
        },
        select: {
          subject: true,
          questions: { select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true } },
        },
      }),
      prisma.examPaper.findMany({
        where: { assignedToId: student.id, paperType: "focused", createdAt: { gte: new Date(Date.now() - 14 * 86400000) } },
        select: { title: true },
      }),
      prisma.examPaper.count({
        where: { assignedToId: student.id, paperType: "quiz", completedAt: { not: null }, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      }),
    ]);

    const recentFocusedTopics = new Set(
      recentFocused.map(f => f.title.replace(/^P\d+ Focused: /, "").replace(/^Focused: /, ""))
    );

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

    const gaps: SubjectGap[] = [];
    const strongTopics: string[] = [];
    for (const [subject, topics] of Object.entries(topicPerf)) {
      const weakTopics = Object.entries(topics)
        .filter(([, v]) => v.available > 0 && (v.earned / v.available) < 0.75)
        .filter(([name]) => !recentFocusedTopics.has(name))
        .sort(([, a], [, b]) => (a.earned / a.available) - (b.earned / b.available))
        .map(([name]) => name)
        .slice(0, 3);
      if (weakTopics.length > 0) gaps.push({ subject, topics: weakTopics });

      const strong = Object.entries(topics)
        .filter(([, v]) => v.available > 0 && (v.earned / v.available) >= 0.8)
        .map(([name]) => name);
      strongTopics.push(...strong.slice(0, 2));
    }

    let summary = `${studentName} (${levelStr}): ${markedPapers.length} papers marked.`;
    if (strongTopics.length > 0) summary += ` Strong in: ${strongTopics.join(", ")}.`;
    if (gaps.length > 0) summary += ` Gaps in: ${gaps.map(g => `${g.subject}: ${g.topics.join(", ")}`).join("; ")}.`;
    else summary += " No significant gaps.";
    summary += ` ${recentQuizCount} quizzes this week.`;
    if (recentFocused.length > 0) summary += ` Recent focused practice: ${recentFocused.map(f => f.title).join(", ")}.`;
    studentSummaries.push(summary);

    if (gaps.length > 0) {
      actions.push({ type: "focused-gap", studentId: student.id, studentName, studentLevel: student.level, gaps });
    }
    if (examType) {
      examComingStudents.push({ id: student.id, name: studentName, level: student.level });
    }
    if (!examType && gaps.length === 0) {
      quizStudents.push({ id: student.id, name: studentName, level: student.level });
    }
  }));

  if (examType && examComingStudents.length > 0) {
    actions.push({ type: "exam-coming", students: examComingStudents, examType });
  }
  if (quizStudents.length > 0) {
    actions.push({ type: "daily-quiz", students: quizStudents });
  }

  // ─── Generate AI greeting via Gemini ───
  const hour = clientHour >= 0 ? clientHour : new Date().getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  let greeting = "";
  try {
    const prompt = `You are a warm AI tutor assistant for ${parentName}, a Singapore primary school parent.

Student diagnostic:
${studentSummaries.join("\n")}
${examContext ? `Note: ${examContext}` : ""}

Write a conversational check-in message (3-4 sentences) as if you've just reviewed the child's work:
1. Greet ${parentName} with "Good ${timeOfDay}" — acknowledge it's ${dayOfWeek}
2. Specifically mention BY NAME which student(s) are struggling and WHICH topics (e.g. "David is having some difficulty with Fractions and Speed in Math")
3. Offer two options naturally: focused practice tests to target the weak topics, OR a daily quiz for general review
4. End with an open invitation ("Feel free to ask me anything too!")

Rules:
- Do NOT use bullet points
- Mention the specific topic names from the diagnostic — do not be vague
- Keep under 90 words
- Sound like a caring tutor who has just looked at the child's papers, not a robot`;

    const response = await getAI().models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.9, maxOutputTokens: 200 },
    });
    if (!response.text) throw new Error("Empty Gemini response");
    greeting = response.text.trim();
  } catch (e) {
    console.error("[recommendations] Gemini greeting failed:", e instanceof Error ? e.message : e);
    // Build a specific fallback from the structured data
    const gapLines = (actions as Action[])
      .filter((a): a is Extract<Action, { type: "focused-gap" }> => a.type === "focused-gap")
      .map(a => `${a.studentName} on ${a.gaps.flatMap(g => g.topics).slice(0, 2).join(" and ")} (${a.gaps[0]?.subject ?? ""})`);
    if (gapLines.length > 0) {
      greeting = `Good ${timeOfDay}, ${parentName}! I've been looking at the recent results and noticed some gaps for ${gapLines.join(", ")}. Would you like to set up some focused practice tests, or assign a daily quiz to keep things moving?`;
    } else if (examType) {
      greeting = `Good ${timeOfDay}, ${parentName}! ${examType} exams are coming up — would you like to assign some past-year paper practice, or set up a daily quiz to review key topics?`;
    } else {
      greeting = `Good ${timeOfDay}, ${parentName}! Things are looking good — want to keep the momentum going with a daily quiz today?`;
    }
  }

  return NextResponse.json({ greeting, actions, summaries: studentSummaries.join(" ") });
}
