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
  const studentIdFilter = req.nextUrl.searchParams.get("studentId") ?? null;
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
  const allLinkedStudents = parent?.parentLinks?.map(l => l.student) ?? [];
  if (allLinkedStudents.length === 0) return NextResponse.json({ greeting: "", actions: [] });
  const linkedStudents = studentIdFilter
    ? allLinkedStudents.filter(s => s.id === studentIdFilter)
    : allLinkedStudents;
  if (linkedStudents.length === 0) return NextResponse.json({ greeting: "", actions: [] });

  const actions: Action[] = [];
  const month = new Date().getMonth() + 1;

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
          paperType: { not: "quiz" },
        },
        select: {
          subject: true,
          questions: { select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true } },
        },
      }),
      prisma.examPaper.findMany({
        where: { assignedToId: student.id, paperType: "focused", completedAt: { not: null }, createdAt: { gte: new Date(Date.now() - 14 * 86400000) } },
        select: { title: true, score: true, totalMarks: true, markingStatus: true },
        orderBy: { completedAt: "desc" },
      }),
      prisma.examPaper.count({
        where: { assignedToId: student.id, paperType: "quiz", completedAt: { not: null }, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      }),
    ]);

    const recentFocusedTopics = new Set(
      recentFocused.map(f => f.title.replace(/^P\d+\s+Focused:\s*/, "").replace(/^Focused:\s*/, ""))
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
    const allWeakBySubject: SubjectGap[] = [];
    for (const [subject, topics] of Object.entries(topicPerf)) {
      const allWeak = Object.entries(topics)
        .filter(([, v]) => v.available > 0 && (v.earned / v.available) < 0.75)
        .sort(([, a], [, b]) => (a.earned / a.available) - (b.earned / b.available))
        .map(([name]) => name)
        .slice(0, 3);
      if (allWeak.length > 0) allWeakBySubject.push({ subject, topics: allWeak });

      // Action gaps: exclude recently practiced topics (to avoid re-suggesting them)
      const actionWeak = allWeak.filter(name => !recentFocusedTopics.has(name));
      if (actionWeak.length > 0) gaps.push({ subject, topics: actionWeak });

      const strong = Object.entries(topics)
        .filter(([, v]) => v.available > 0 && (v.earned / v.available) >= 0.8)
        .map(([name]) => name);
      strongTopics.push(...strong.slice(0, 2));
    }

    // Summary uses raw weak topics (not filtered by recent practice) so AI has accurate picture
    let summary = `${studentName} (${levelStr}): ${markedPapers.length} papers marked.`;
    if (strongTopics.length > 0) summary += ` Strong in: ${strongTopics.join(", ")}.`;
    if (allWeakBySubject.length > 0) summary += ` Weak topics: ${allWeakBySubject.map(g => `${g.subject}: ${g.topics.join(", ")}`).join("; ")}.`;
    else summary += " No significant gaps.";
    summary += ` ${recentQuizCount} quizzes this week.`;
    if (recentFocused.length > 0) {
      const focusedLines = recentFocused.map(f => {
        const topic = f.title.replace(/^P\d+ Focused: /, "").replace(/^Focused: /, "");
        if (f.score !== null && f.totalMarks) {
          const total = parseFloat(f.totalMarks);
          const pct = total > 0 ? Math.round((f.score / total) * 100) : null;
          const verdict = pct === null ? "" : pct >= 80 ? " (did well)" : pct >= 60 ? " (improving)" : " (needs more practice)";
          return `${topic}${pct !== null ? ` — ${pct}%${verdict}` : ""}`;
        }
        return topic;
      });
      summary += ` Recent focused practice: ${focusedLines.join("; ")}.`;
    }
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
    const isStudentSpecific = studentIdFilter && linkedStudents.length === 1;
    const prompt = isStudentSpecific
      ? `You are a warm AI tutor assistant. Write a concise 2-3 sentence insight for ${parentName} about their child.

Student diagnostic:
${studentSummaries.join("\n")}
${examContext ? `Note: ${examContext}` : ""}

Rules:
- 2-3 sentences only — no greetings, no sign-offs
- If the student recently completed focused practice, call it out personally and specifically — e.g. "Emily recently did a focused test on Fractions and did well! Encourage her on her improvement." Use the actual topic name and result (did well / improving / needs more practice).
- If focused practice score was 80%+, celebrate the achievement and tell the parent to praise the child
- If focused practice score was 60–79%, say they're improving and encourage continued practice
- If focused practice score was below 60%, say they need more practice and suggest another focused test
- If there are weak topics not yet practised, name them and suggest focused practice
- If performing well overall, acknowledge it and suggest a daily quiz to maintain momentum
- Use **double asterisks** to bold: the child's name, topic names, percentages (e.g. **80%**), and key summary phrases (e.g. **performing well**, **needs more practice**, **no significant gaps**)
- No bullet points, no numbered lists, no markdown other than **bold**`
      : `You are a warm AI tutor assistant for ${parentName}, a Singapore primary school parent.

Student diagnostic:
${studentSummaries.join("\n")}
${examContext ? `Note: ${examContext}` : ""}

Write a warm, conversational check-in message of 3-4 flowing sentences. Do NOT number the sentences.

Start by greeting ${parentName} with "Good ${timeOfDay}". If any student recently completed focused practice, call it out specifically and personally — e.g. "Emily recently did a focused test on Fractions and did well! Encourage her on her improvement." Use the actual student name, topic name, and result. Naturally mention BY NAME which student(s) and WHICH specific topics they're finding difficult. Then offer two options: focused practice tests for the weak topics, or a daily quiz for general review.

Rules:
- No bullet points, no numbered lists
- If recent focused practice results are available, ALWAYS call out performance personally (student name + topic + result) and tell the parent to praise/encourage the child
- If score was 80%+, celebrate and tell parent to praise the child; if 60–79%, say improving; if below 60%, suggest more practice
- Mention specific topic names from the diagnostic — do not be vague
- Use **double asterisks** to bold: student names, topic names, percentages (e.g. **80%**), and key summary phrases (e.g. **performing well**, **needs more practice**, **no significant gaps**)
- No other markdown or formatting`;

    const response = await getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.9 },
    });
    if (!response.text) throw new Error("Empty Gemini response");
    greeting = response.text.trim().replace(/\*\*(.+?)\*\*/g, "$1");
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
