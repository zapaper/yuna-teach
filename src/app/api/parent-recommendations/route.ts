import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveActor } from "@/lib/auth-guard";
import { generateContentWithRetry } from "@/lib/gemini";

type SubjectGap = { subject: string; topics: string[] };

type Action =
  | { type: "focused-gap"; studentId: string; studentName: string; studentLevel: number | null; gaps: SubjectGap[] }
  | { type: "exam-coming"; students: { id: string; name: string; level: number | null }[]; examType: string }
  | { type: "daily-quiz"; students: { id: string; name: string; level: number | null }[] };

export async function GET(req: NextRequest) {
  // Caller identity comes from the signed session cookie. The old
  // ?parentId= param was spoofable; now admins may still pass it
  // to act on another parent's behalf, but non-admins are forced
  // to their own id.
  const target = req.nextUrl.searchParams.get("parentId");
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parentId = auth.userId;
  const studentIdFilter = req.nextUrl.searchParams.get("studentId") ?? null;
  const clientHour = parseInt(req.nextUrl.searchParams.get("hour") ?? "-1", 10);

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

    // Run all 4 DB queries for this student in parallel
    const [markedPapers, recentFocused, recentQuizCount, pendingReviewPapers] = await Promise.all([
      prisma.examPaper.findMany({
        where: {
          assignedToId: student.id,
          markingStatus: { in: ["complete", "released"] },
        },
        select: {
          subject: true,
          metadata: true,
          questions: { select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true } },
        },
      }),
      prisma.examPaper.findMany({
        where: { assignedToId: student.id, paperType: "focused", completedAt: { not: null }, createdAt: { gte: new Date(Date.now() - 14 * 86400000) } },
        select: { title: true, subject: true, score: true, totalMarks: true, markingStatus: true },
        orderBy: { completedAt: "desc" },
      }),
      prisma.examPaper.count({
        where: { assignedToId: student.id, paperType: "quiz", completedAt: { not: null }, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      }),
      // Pending Review = AI-marked papers parent hasn't acknowledged yet.
      // Mirrors ParentDashboard.pendingRelease: completed + markingStatus=complete + not a revision paper.
      prisma.examPaper.findMany({
        where: {
          assignedToId: student.id,
          completedAt: { not: null },
          markingStatus: "complete",
        },
        select: { metadata: true },
      }),
    ]);
    const pendingReviewCount = pendingReviewPapers.filter(p => {
      const meta = p.metadata as { revisionMode?: string } | null;
      return !meta?.revisionMode;
    }).length;

    const recentFocusedTopics = new Set(
      recentFocused.map(f => f.title.replace(/^P\d+\s+Focused:\s*/, "").replace(/^Focused:\s*/, ""))
    );

    const topicPerf: Record<string, Record<string, { earned: number; available: number }>> = {};
    for (const paper of markedPapers) {
      // Skip revision papers (curated past mistakes) — counting them
      // would double-count those mistakes and skew weak-topic gaps.
      const meta = paper.metadata as { revisionMode?: string } | null;
      if (meta?.revisionMode) continue;
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
    // Track the % per weak topic so the AI prompt can include it
    // when naming weak areas (e.g. "Ratio (78%)"). Keyed by topic name.
    const weakPctByTopic: Record<string, number> = {};
    for (const [subject, topics] of Object.entries(topicPerf)) {
      // Aligned with front-end: weak = ≤ 75%, strong = > 75%. Weakest first.
      const allWeakWithPct = Object.entries(topics)
        .filter(([, v]) => v.available > 0 && (v.earned / v.available) <= 0.75)
        .sort(([, a], [, b]) => (a.earned / a.available) - (b.earned / b.available))
        .slice(0, 3)
        .map(([name, v]) => ({ name, pct: Math.round((v.earned / v.available) * 100) }));
      for (const w of allWeakWithPct) weakPctByTopic[w.name] = w.pct;
      const allWeak = allWeakWithPct.map(w => w.name);
      if (allWeak.length > 0) allWeakBySubject.push({ subject, topics: allWeak });

      // Action gaps: exclude recently practiced topics (to avoid re-suggesting them)
      const actionWeak = allWeak.filter(name => !recentFocusedTopics.has(name));
      if (actionWeak.length > 0) gaps.push({ subject, topics: actionWeak });

      const strong = Object.entries(topics)
        .filter(([, v]) => v.available > 0 && (v.earned / v.available) > 0.75)
        .sort(([, a], [, b]) => (b.earned / b.available) - (a.earned / a.available))
        .map(([name]) => name);
      strongTopics.push(...strong.slice(0, 2));
    }

    // Summary uses raw weak topics (not filtered by recent practice) so AI has accurate picture
    let summary = `${studentName} (${levelStr}): ${markedPapers.length} papers marked.`;
    if (strongTopics.length > 0) summary += ` Strong in: ${strongTopics.join(", ")}.`;
    if (allWeakBySubject.length > 0) {
      const weakWithPct = allWeakBySubject.map(g => {
        const topicsWithPct = g.topics.map(t => weakPctByTopic[t] != null ? `${t} (${weakPctByTopic[t]}%)` : t);
        return `${g.subject}: ${topicsWithPct.join(", ")}`;
      }).join("; ");
      summary += ` Weak topics: ${weakWithPct}.`;
    }
    else summary += " No significant gaps.";
    summary += ` ${recentQuizCount} quizzes this week. ${pendingReviewCount} papers pending review.`;
    if (recentFocused.length > 0) {
      const focusedLines = recentFocused.map(f => {
        const topic = f.title.replace(/^P\d+ Focused: /, "").replace(/^Focused: /, "");
        if (f.score !== null && f.totalMarks) {
          const total = parseFloat(f.totalMarks);
          const pct = total > 0 ? Math.round((f.score / total) * 100) : null;
          // Baseline = the topic's average across all OTHER marked papers
          // (excluding this focused test). If the focused score is higher than
          // that baseline, the student genuinely pulled the topic average up
          // — that's what "improving" means here. If below, no improvement
          // claim is made. "did well" still fires on 80%+ regardless.
          const tp = f.subject ? topicPerf[f.subject]?.[topic] : null;
          let baselinePct: number | null = null;
          if (tp && f.score !== null && total > 0) {
            const baseEarned = tp.earned - f.score;
            const baseAvailable = tp.available - total;
            baselinePct = baseAvailable > 0
              ? Math.round((baseEarned / baseAvailable) * 100)
              : null;
          }
          const verdict = pct === null
            ? ""
            : pct >= 80
              ? " (did well)"
              : (baselinePct !== null && pct > baselinePct)
                ? ` (improving — pulled the topic average up from ${baselinePct}% to ${pct}%)`
                : " (needs more practice)";
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
    const prompt = `You are a warm AI coaching assistant for ${parentName}, a Singapore primary school parent.

Student diagnostic:
${studentSummaries.join("\n")}
${examContext ? `Note: ${examContext}` : ""}

Output 2-3 SHORT bullet points coaching the parent on the next move. Each bullet starts with "• " and is one short sentence (max ~20 words). No greetings, no intros, no sign-offs. Output ONLY the bullets, separated by newlines.

The bullets, in this order:

BULLET 1 (always include — PRAISE/ENCOURAGE):
- If any student recently completed a focused test, name student + topic + verdict and tell the parent to praise/encourage. Verdicts come from the diagnostic in parentheses: (did well) → celebrate; (improving — pulled the topic average up from X% to Y%) → say the practice lifted the average, keep going; (needs more practice) → acknowledge effort, more practice needed.
- If no recent focused test, give a brief warm note about overall progress or a strong topic.
- Do NOT claim "improving" unless the diagnostic verdict says "improving".

BULLET 2 (include ONLY if any student has 3+ papers pending review):
- Prompt parent to clear the backlog using the **Revise Work** function. Mention the number pending and the student name.

BULLET 3 (always include — NEXT ACTION):
- If there are weak topics not yet practised, name 1-2 and suggest **Focused Practice**. ALWAYS include the topic's % from the diagnostic in bold immediately after the topic name, e.g. "Suggest **Focused Practice** on **Ratio** (**78%**) and **Fractions** (**62%**)".
- Otherwise suggest a **Daily Quiz** to maintain momentum.

Formatting rules:
- Use **double asterisks** to bold: student names, topic names, percentages (e.g. **80%**), and key actions (**Revise Work**, **Focused Practice**, **Daily Quiz**).
- Use • (bullet character) at the start of each line, followed by a space.
- One bullet per line. No other markdown.`;

    const response = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.9 },
    }, 3, 4000, "recs-greeting");
    if (!response.text) throw new Error("Empty Gemini response");
    greeting = response.text.trim();
  } catch (e) {
    console.error("[recommendations] Gemini greeting failed:", e instanceof Error ? e.message : e);
    // Build a bullet fallback from the structured data
    const gapAction = (actions as Action[]).find((a): a is Extract<Action, { type: "focused-gap" }> => a.type === "focused-gap");
    const bullets: string[] = [];
    bullets.push(`• Keep encouraging **${linkedStudents[0]?.name ?? "your child"}** — every quiz is progress.`);
    if (gapAction) {
      const topics = gapAction.gaps.flatMap(g => g.topics).slice(0, 2).map(t => `**${t}**`).join(" and ");
      bullets.push(`• Try **Focused Practice** on ${topics} for **${gapAction.studentName}**.`);
    } else if (examType) {
      bullets.push(`• **${examType}** is coming — assign a past-year paper or **Daily Quiz** to revise key topics.`);
    } else {
      bullets.push(`• Keep momentum with a **Daily Quiz** today.`);
    }
    greeting = bullets.join("\n");
  }

  return NextResponse.json({ greeting, actions, summaries: studentSummaries.join(" ") });
}
