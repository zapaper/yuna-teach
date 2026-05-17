import { prisma } from "../src/lib/db";

// Audit completed quiz / focused papers from the last 10 days.
// For each MCQ question, recompute marks via the same comparison
// the submit + marker use, and compare to the stored marksAwarded.
// Flag any paper where they disagree — those are the silently-
// mis-marked clones the markingNotes:null Vocab MCQ paper hinted
// at. Read-only — does not write to the DB.

(async () => {
  const since = new Date(Date.now() - 10 * 86400_000);
  console.log(`Scanning quiz/focused papers completed since ${since.toISOString().slice(0, 10)}…`);

  const papers = await prisma.examPaper.findMany({
    where: {
      paperType: { in: ["quiz", "focused"] },
      completedAt: { gte: since },
      markingStatus: "complete",
    },
    select: {
      id: true, title: true, subject: true, score: true, totalMarks: true,
      completedAt: true, assignedToId: true,
      assignedTo: { select: { name: true } },
      questions: {
        select: { id: true, questionNum: true, transcribedOptions: true, transcribedOptionImages: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, syllabusTopic: true },
      },
    },
    orderBy: { completedAt: "desc" },
  });
  console.log(`Pulled ${papers.length} papers. Auditing MCQ marks…\n`);

  const isMcq = (opts: unknown, optImgs: unknown, answer: string | null) => {
    if (Array.isArray(opts) && opts.length === 4) return true;
    if (Array.isArray(optImgs) && optImgs.some((o) => !!o)) return true;
    const a = (answer ?? "").trim().replace(/[().]/g, "");
    return a === "1" || a === "2" || a === "3" || a === "4";
  };
  const normalize = (s: string | null) => (s ?? "").trim().replace(/[().]/g, "").trim();

  let totalAffected = 0;
  let totalQuestionsWrong = 0;
  type Affected = { paperId: string; title: string; assignee: string | null; storedScore: number | null; computedScore: number; wrongQs: number; topicSamples: string[] };
  const affectedRows: Affected[] = [];

  for (const p of papers) {
    let storedSum = 0;
    let computedSum = 0;
    let mcqWrong = 0;
    const topicCounts: Record<string, number> = {};
    for (const q of p.questions) {
      if (!isMcq(q.transcribedOptions, q.transcribedOptionImages, q.answer)) continue;
      const studentAns = normalize(q.studentAnswer);
      const correctAns = normalize(q.answer);
      // Skip rows the student didn't answer — null marksAwarded means
      // "skipped", not "mis-marked".
      if (q.marksAwarded == null) continue;
      const acceptable = correctAns.split(/\s+or\s+/).map((p) => p.trim());
      const computedCorrect = studentAns !== "" && acceptable.includes(studentAns);
      const computedMarks = computedCorrect ? (q.marksAvailable ?? 1) : 0;
      storedSum += q.marksAwarded;
      computedSum += computedMarks;
      if (computedMarks !== q.marksAwarded) {
        mcqWrong++;
        const t = q.syllabusTopic ?? "?";
        topicCounts[t] = (topicCounts[t] ?? 0) + 1;
      }
    }
    if (mcqWrong > 0) {
      totalAffected++;
      totalQuestionsWrong += mcqWrong;
      const topicSamples = Object.entries(topicCounts).sort(([, a], [, b]) => b - a).slice(0, 3).map(([t, c]) => `${t}(${c})`);
      affectedRows.push({
        paperId: p.id,
        title: p.title,
        assignee: p.assignedTo?.name ?? null,
        storedScore: p.score,
        computedScore: computedSum,
        wrongQs: mcqWrong,
        topicSamples,
      });
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`AFFECTED: ${totalAffected} of ${papers.length} papers  (${totalQuestionsWrong} questions mis-marked total)`);
  console.log(`${"=".repeat(80)}\n`);

  for (const a of affectedRows) {
    console.log(`  ${a.paperId}  stored=${a.storedScore}  computed=${a.computedScore}  ${a.wrongQs} wrong MCQ`);
    console.log(`    "${a.title}"  assignee=${a.assignee}`);
    console.log(`    topics: ${a.topicSamples.join(", ")}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
