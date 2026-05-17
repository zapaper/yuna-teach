// One-off restore: the clone of P5 Focused water-cycle Q9 had its
// answer field overwritten by the auto-solve fallback (it wrote an
// AI-generated step-by-step solution into the answer field, destroying
// the actual answer key). Copy the answer back from the master, and
// clear the resulting "[solve on demand]" markingNotes.
//
// DRY-RUN:  npx tsx scripts/restore-q9-2j-answer.ts
// APPLY:    npx tsx scripts/restore-q9-2j-answer.ts --apply
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const CLONE_PAPER_ID = "cmp2j7rqj000ojp6v1rz533lm";
const Q_NUM = "9";

async function main() {
  const clone = await prisma.examQuestion.findFirst({
    where: { examPaperId: CLONE_PAPER_ID, questionNum: Q_NUM },
    select: { id: true, answer: true, markingNotes: true, sourceQuestionId: true },
  });
  if (!clone || !clone.sourceQuestionId) { console.log("clone or source not found"); return; }
  const master = await prisma.examQuestion.findUnique({
    where: { id: clone.sourceQuestionId },
    select: { answer: true },
  });
  if (!master?.answer) { console.log("master answer missing"); return; }

  console.log("Clone id:", clone.id);
  console.log("Current clone answer (first 250):");
  console.log("  " + (clone.answer ?? "").slice(0, 250));
  console.log("Master answer:");
  console.log("  " + master.answer);
  console.log("Current clone markingNotes (first 250):");
  console.log("  " + (clone.markingNotes ?? "(none)").slice(0, 250));

  if (!APPLY) {
    console.log("\nDry-run — re-run with --apply to commit.");
    return;
  }

  await prisma.examQuestion.update({
    where: { id: clone.id },
    data: {
      answer: master.answer,
      // Clear the "[solve on demand]" marker — the answer is now the
      // real key, so the next re-mark won't fire auto-solve again.
      markingNotes: clone.markingNotes && /^\[solve on demand\]/.test(clone.markingNotes)
        ? null
        : clone.markingNotes,
    },
  });
  console.log("\nApplied — clone answer restored from master.");
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
