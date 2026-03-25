import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 30000 } });
  return _ai;
}

type SubjectGap = { subject: string; topics: string[] };

type Action =
  | { type: "focused-gap"; studentId: string; studentName: string; studentLevel: number | null; gaps: SubjectGap[] }
  | { type: "exam-coming"; students: { id: string; name: string; level: number | null }[]; examType: string }
  | { type: "daily-quiz"; students: { id: string; name: string; level: number | null }[] };

export async function GET(req: NextRequest) {
  const parentId = req.nextUrl.searchParams.get("parentId");
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
  const day = new Date().getDate();
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

  for (const student of linkedStudents) {
    const studentName = student.name ?? "Student";
    const levelStr = student.level ? `Primary ${student.level}` : "";

    // Get performance data
    const markedPapers = await prisma.examPaper.findMany({
      where: {
        assignedToId: student.id,
        markingStatus: { in: ["complete", "released"] },
        paperType: { not: "focused" },
      },
      select: {
        subject: true,
        questions: { select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true } },
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
      where: { assignedToId: student.id, paperType: "focused", createdAt: { gte: new Date(Date.now() - 14 * 86400000) } },
      select: { title: true },
    });
    const recentFocusedTopics = new Set(
      recentFocused.map(f => f.title.replace(/^P\d+ Focused: /, "").replace(/^Focused: /, ""))
    );

    // Recent quiz count
    const recentQuizCount = await prisma.examPaper.count({
      where: { assignedToId: student.id, paperType: "quiz", completedAt: { not: null }, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
    });

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

    // Build student context for AI
    let summary = `${studentName} (${levelStr}): ${markedPapers.length} papers marked.`;
    if (strongTopics.length > 0) summary += ` Strong in: ${strongTopics.join(", ")}.`;
    if (gaps.length > 0) summary += ` Gaps in: ${gaps.map(g => `${g.subject}: ${g.topics.join(", ")}`).join("; ")}.`;
    else summary += " No significant gaps.";
    summary += ` ${recentQuizCount} quizzes this week.`;
    if (recentFocused.length > 0) summary += ` Recent focused practice: ${recentFocused.map(f => f.title).join(", ")}.`;
    studentSummaries.push(summary);

    // Build actions
    if (gaps.length > 0) {
      actions.push({ type: "focused-gap", studentId: student.id, studentName, studentLevel: student.level, gaps });
    }
    if (examType) {
      examComingStudents.push({ id: student.id, name: studentName, level: student.level });
    }
    if (!examType && gaps.length === 0) {
      quizStudents.push({ id: student.id, name: studentName, level: student.level });
    }
  }

  if (examType && examComingStudents.length > 0) {
    actions.push({ type: "exam-coming", students: examComingStudents, examType });
  }
  if (quizStudents.length > 0) {
    actions.push({ type: "daily-quiz", students: quizStudents });
  }

  // ─── Generate AI greeting via Gemini ───
  let greeting = "";
  try {
    const prompt = `You are a warm, empathetic AI teaching assistant for a parent in Singapore. Your name is Mark (from MarkForYou.com).

Context:
- Today is ${dayOfWeek}, ${day}/${month}.
- Parent's name: ${parentName}
- ${examContext || "No major exams coming up soon."}
- Students: ${studentSummaries.join(" ")}

Available actions you can suggest (DO NOT list them as bullet points — weave them naturally into your message):
${actions.map(a => {
  if (a.type === "focused-gap") return `- Create focused practice for ${a.studentName} on ${a.gaps.map(g => `${g.subject}: ${g.topics.join(", ")}`).join(" and ")}`;
  if (a.type === "exam-coming") return `- Assign past-year ${a.examType} paper practice for ${a.students.map(s => s.name).join(", ")}`;
  if (a.type === "daily-quiz") return `- Assign a daily quiz for ${a.students.map(s => s.name).join(", ")}`;
  return "";
}).join("\n")}

Write a short, warm greeting (2-4 sentences). Be conversational, not formulaic. Include:
1. A brief empathetic or encouraging opening relevant to the time/context (e.g. exam season stress, weekend rest, weekday routine)
2. A natural suggestion of what to do today based on the actions above

Rules:
- Do NOT use bullet points or numbered lists
- Do NOT mention "MarkForYou" or "Mark" in the greeting
- Do NOT repeat the student data verbatim — summarise naturally
- Keep it under 60 words
- Be warm but concise — like a helpful friend, not a robot
- Use the parent's first name if available`;

    const response = await getAI().models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.9, maxOutputTokens: 150 },
    });
    greeting = (response.text ?? "").trim();
  } catch (e) {
    console.error("[recommendations] Gemini greeting failed:", e);
    // Fallback to a simple greeting
    const h = new Date().getHours();
    const timeGreeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    greeting = `${timeGreeting}, ${parentName}! Here are some suggestions for today.`;
  }

  return NextResponse.json({ greeting, actions });
}
