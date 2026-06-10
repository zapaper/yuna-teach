// Count of attempted exam-paper questions across real users.
//
// "Attempted" = the question has a non-null marksAwarded — i.e. the
// marker ran on it. This excludes still-pending / unmarked rows.
// Subparts already count as 1 because the extractor creates a
// separate ExamQuestion row per subpart (Q1a, Q1bc, etc.).
//
// Excludes:
//   - admin (Peter)
//   - student666 (test student)
//   - student555 (test student)
//   - master / template papers (we only count CLONES — the actual
//     submissions kids did, not the bank rows the masters live on).
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_count-attempted-questions.ts

import { prisma } from "../src/lib/db";

const EXCLUDED_NAMES = new Set(["student666", "student555", "admin"]);

(async () => {
  // Resolve user ids to exclude. Matches the isAdmin() helper:
  //   - login username "admin" (case-insensitive)
  //   - settings.admin === true
  // PLUS explicit student666 / student555 test accounts.
  const all = await prisma.user.findMany({
    select: { id: true, name: true, role: true, settings: true },
  });
  const excludedUsers = all.filter(u => {
    const lower = (u.name ?? "").toLowerCase();
    if (lower === "admin") return true;
    if (EXCLUDED_NAMES.has(lower)) return true;
    const s = u.settings as { admin?: unknown } | null;
    if (s?.admin === true) return true;
    return false;
  });
  console.log(`Excluding ${excludedUsers.length} user(s):`);
  for (const u of excludedUsers) {
    console.log(`  - ${u.name} (${u.role}) ${u.id}`);
  }
  const excludedIds = excludedUsers.map(u => u.id);

  // Attempted = clone questions with marksAwarded set (not the
  // masters in the bank). A "clone" is any paper with sourceExamId
  // OR with paperType in {quiz, focused, mastery, eval}.
  const total = await prisma.examQuestion.count({
    where: {
      marksAwarded: { not: null },
      examPaper: {
        OR: [
          { sourceExamId: { not: null } },
          { paperType: { in: ["quiz", "focused", "mastery", "mastery-review"] } },
        ],
        // Skip eval clones (they were ours, not real attempts).
        paperType: { not: "eval" },
        // Exclude papers owned by or assigned to excluded users.
        ...(excludedIds.length > 0 ? {
          AND: [
            { userId: { notIn: excludedIds } },
            { OR: [
              { assignedToId: null },
              { assignedToId: { notIn: excludedIds } },
            ] },
          ],
        } : {}),
      },
    },
  });
  console.log(`\nAttempted questions (marksAwarded != null): ${total}`);

  // Also show breakdown by subject for context.
  const bySubject = await prisma.examQuestion.groupBy({
    by: ["examPaperId"],
    where: {
      marksAwarded: { not: null },
      examPaper: {
        OR: [
          { sourceExamId: { not: null } },
          { paperType: { in: ["quiz", "focused", "mastery", "mastery-review"] } },
        ],
        paperType: { not: "eval" },
        ...(excludedIds.length > 0 ? {
          AND: [
            { userId: { notIn: excludedIds } },
            { OR: [
              { assignedToId: null },
              { assignedToId: { notIn: excludedIds } },
            ] },
          ],
        } : {}),
      },
    },
    _count: { _all: true },
  });
  // Roll up by subject.
  const paperIds = bySubject.map(r => r.examPaperId);
  const papers = await prisma.examPaper.findMany({
    where: { id: { in: paperIds } },
    select: { id: true, subject: true },
  });
  const subjOfPaper = new Map(papers.map(p => [p.id, (p.subject ?? "").toLowerCase()]));
  const subj = { english: 0, chinese: 0, math: 0, science: 0, other: 0 };
  for (const r of bySubject) {
    const s = subjOfPaper.get(r.examPaperId) ?? "";
    const bucket =
      s.includes("chinese") || /[一-鿿]/.test(s) ? "chinese" :
      s.includes("english") ? "english" :
      s.includes("math") ? "math" :
      s.includes("science") ? "science" : "other";
    subj[bucket] += r._count._all;
  }
  console.log(`By subject:`);
  for (const [k, v] of Object.entries(subj)) {
    if (v > 0) console.log(`  ${k.padEnd(8)} ${v}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
