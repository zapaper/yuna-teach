// Reset student67's history so the incoming onboarding-diagnostic
// quizzes fresh-populate the Lumi read.
//
// Scope: papers ASSIGNED TO student67 that are NOT the newly-created
// onboarding-diagnostic quizzes (metadata.onboardingDiagnostic=true).
// Delete both the paper row and its questions. Also clears any
// SPRun cache stored on the student's settings.tutorCache and the
// Lumi lastweek snapshot.
//
// Dry-run by default; pass --apply to write.

import "dotenv/config";
import { prisma } from "../src/lib/db";

const STUDENT_ID = "cmqg8upha0000l3ijfr3co6t8"; // student67
const APPLY = process.argv.includes("--apply");

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: STUDENT_ID },
    select: {
      id: true, title: true, paperType: true, markingStatus: true,
      completedAt: true, metadata: true,
      _count: { select: { questions: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Papers assigned to student67: ${papers.length}`);
  const keep: string[] = [];
  const drop: string[] = [];
  for (const p of papers) {
    const meta = (p.metadata ?? {}) as { onboardingDiagnostic?: boolean };
    if (meta.onboardingDiagnostic === true) {
      keep.push(p.id);
      console.log(`  KEEP  ${p.id}  ${(p.paperType ?? "master").padEnd(8)}  qs=${p._count.questions.toString().padStart(3)}  → ${p.title}`);
    } else {
      drop.push(p.id);
      console.log(`  DROP  ${p.id}  ${(p.paperType ?? "master").padEnd(8)}  qs=${p._count.questions.toString().padStart(3)}  → ${p.title}`);
    }
  }
  console.log(`\nKeep: ${keep.length}  ·  Drop: ${drop.length}`);

  const user = await prisma.user.findUnique({
    where: { id: STUDENT_ID },
    select: { settings: true },
  });
  const settings = (user?.settings ?? {}) as Record<string, unknown>;
  const cacheKeys = Object.keys(settings).filter(k => k === "tutorCache" || k === "lumiLastWeek" || k === "activationNudgeSent" || k === "activationFollowupSent" || k === "lumiIntroSent");
  console.log(`\nStudent settings cache keys to clear: ${cacheKeys.join(", ") || "(none)"}`);

  if (!APPLY) {
    console.log(`\n[DRY RUN] Nothing written. Re-run with --apply.`);
    await prisma.$disconnect();
    return;
  }

  // Delete questions first (cascade may not be set), then papers.
  if (drop.length > 0) {
    const qs = await prisma.examQuestion.deleteMany({ where: { examPaperId: { in: drop } } });
    console.log(`Deleted ${qs.count} questions.`);
    const ps = await prisma.examPaper.deleteMany({ where: { id: { in: drop } } });
    console.log(`Deleted ${ps.count} papers.`);
  }
  if (cacheKeys.length > 0) {
    const cleaned: Record<string, unknown> = { ...settings };
    for (const k of cacheKeys) delete cleaned[k];
    await prisma.user.update({ where: { id: STUDENT_ID }, data: { settings: cleaned } });
    console.log(`Cleared ${cacheKeys.length} settings keys.`);
  }
  console.log(`\nDone. student67 now has only the ${keep.length} onboarding-diagnostic quizzes.`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
