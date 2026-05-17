import { prisma } from "../src/lib/db";

// Audit recent quiz / focused paper OEQ questions where the marker
// reported "blank" but the student didn't explicitly skip — these
// are candidates for the flash-vision-misread bug. We can't open
// the submission files from a local script (they live on the
// production Railway volume), so we surface candidates from DB
// signals only and let a re-mark on production prove or disprove.

(async () => {
  const since = new Date(Date.now() - 10 * 86400_000);
  console.log(`Scanning quiz / focused papers completed since ${since.toISOString().slice(0, 10)}…\n`);

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
        select: { id: true, questionNum: true, transcribedOptions: true, transcribedOptionImages: true, transcribedSubparts: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true },
      },
    },
    orderBy: { completedAt: "desc" },
  });

  const isMcq = (opts: unknown, optImgs: unknown, answer: string | null) => {
    if (Array.isArray(opts) && opts.length === 4) return true;
    if (Array.isArray(optImgs) && optImgs.some((o) => !!o)) return true;
    const a = (answer ?? "").trim().replace(/[().]/g, "");
    return a === "1" || a === "2" || a === "3" || a === "4";
  };

  type Hit = { paperId: string; title: string; subject: string | null; assignee: string | null; questionNum: string; markedZero: boolean; notesPreview: string };
  const hits: Hit[] = [];
  const affectedPapers = new Set<string>();

  for (const p of papers) {
    for (const q of p.questions) {
      if (isMcq(q.transcribedOptions, q.transcribedOptionImages, q.answer)) continue;
      // OEQ. Look for the flash-blank signature.
      const notes = q.markingNotes ?? "";
      const studentAns = q.studentAnswer ?? "";
      if (studentAns === "__SKIPPED__") continue;
      // Signature 1: notes start with "Detected: ... blank" — flash returned blank
      // for at least one part. Could be per-subpart (e.g. "(a) blank") or wholly
      // blank ("Detected: blank").
      const hasDetectedBlank = /Detected:\s*[^|]*\bblank\b/i.test(notes);
      // Signature 2: studentAnswer says "blank" but the marker awarded 0 (so the
      // model recorded blank). Catches multi-subpart cases where studentAnswer
      // is "Working:\n(a) blank\n(b) blank\n(c) blank".
      const studentSaysBlank = /\bblank\b/i.test(studentAns);
      if (!(hasDetectedBlank || studentSaysBlank)) continue;
      // Skip rows where the marker explicitly said "No written answer found" or
      // "No answer provided" — those went through the pixel pre-check and ink
      // really wasn't there. The flash-misread bug shows up as "Detected: blank"
      // / studentAnswer "blank" only when the pixel check confirmed ink first.
      if (/No written answer found/i.test(notes)) continue;
      if (notes.startsWith("(") && notes.includes(") No answer provided.")) continue;
      // Multi-subpart questions are the ones we've seen flash mis-read on.
      // Single-canvas OEQ blank is far more often actually blank.
      const subs = q.transcribedSubparts as Array<{ label: string; text: string }> | null;
      const realSubs = (subs ?? []).filter((s) => !s.label.startsWith("_"));
      const isMultiSubpart = realSubs.length > 1;
      if (!isMultiSubpart) continue;

      hits.push({
        paperId: p.id,
        title: p.title,
        subject: p.subject,
        assignee: p.assignedTo?.name ?? null,
        questionNum: q.questionNum,
        markedZero: q.marksAwarded === 0,
        notesPreview: notes.replace(/\s+/g, " ").slice(0, 120),
      });
      affectedPapers.add(p.id);
    }
  }

  console.log(`${"=".repeat(80)}`);
  console.log(`Candidates found: ${hits.length} questions across ${affectedPapers.size} papers (out of ${papers.length} scanned)`);
  console.log(`${"=".repeat(80)}\n`);

  // Group by paper for cleaner output
  const byPaper = new Map<string, Hit[]>();
  for (const h of hits) {
    if (!byPaper.has(h.paperId)) byPaper.set(h.paperId, []);
    byPaper.get(h.paperId)!.push(h);
  }
  for (const [pid, qs] of byPaper) {
    const first = qs[0];
    console.log(`  ${pid}  "${first.title}"  ${first.subject}  for ${first.assignee}`);
    for (const h of qs) {
      console.log(`    Q${h.questionNum}  ${h.markedZero ? "0 marks" : "partial"}  notes: ${h.notesPreview}`);
    }
  }

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
