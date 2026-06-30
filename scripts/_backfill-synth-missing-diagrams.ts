// Back-propagate diagramImageData from masters to synthetic rows that
// lost the diagram during generation. Two targets:
//   (A) the single ExamQuestion row in [Synthetic Bank] Math P5 (q S3)
//       whose source master has a diagram but the bank row doesn't
//   (B) 6 SyntheticQuestion rows across the global table whose source
//       master has a diagram but the synth row doesn't
//
// Usage:
//   npx tsx scripts/_backfill-synth-missing-diagrams.ts --dry-run   # list only
//   npx tsx scripts/_backfill-synth-missing-diagrams.ts             # apply

import "dotenv/config";
import { prisma } from "../src/lib/db";

const DRY = process.argv.includes("--dry-run");

type SubP = { label?: string; diagramBase64?: string };

(async () => {
  // ── A: ExamQuestion rows in any synthetic-bank-style paper ─────
  // Scope to the one paper that surfaced the bug; broaden later if
  // more synthetic banks exist.
  const bankPaperId = "cmo82pjw3004y12oh6o2ub3kt";
  const bankRows = await prisma.examQuestion.findMany({
    where: { examPaperId: bankPaperId, sourceQuestionId: { not: null } },
    select: { id: true, questionNum: true, sourceQuestionId: true, diagramImageData: true, transcribedSubparts: true },
  });
  const bankMasterIds = [...new Set(bankRows.map(r => r.sourceQuestionId!).filter(Boolean))];
  const bankMasters = await prisma.examQuestion.findMany({
    where: { id: { in: bankMasterIds } },
    select: { id: true, diagramImageData: true, transcribedSubparts: true },
  });
  const bankMasterById = new Map(bankMasters.map(m => [m.id, m]));

  type BankFix = { rowId: string; qNum: string; diagBytes: number };
  const bankFixes: BankFix[] = [];
  for (const r of bankRows) {
    if ((r.diagramImageData?.length ?? 0) > 0) continue;          // already has it
    const m = bankMasterById.get(r.sourceQuestionId!);
    if (!m) continue;
    const md = m.diagramImageData;
    if (!md || md.length === 0) continue;                          // master has nothing to give
    bankFixes.push({ rowId: r.id, qNum: r.questionNum, diagBytes: md.length });
  }

  // ── B: SyntheticQuestion table rows ────────────────────────────
  const allSynth = await prisma.syntheticQuestion.findMany({
    select: { id: true, sourceQuestionId: true, diagramImageData: true },
  });
  const missing = allSynth.filter(s => (s.diagramImageData?.length ?? 0) === 0 && s.sourceQuestionId);
  const synthMasterIds = [...new Set(missing.map(s => s.sourceQuestionId!))];
  const synthMasters = await prisma.examQuestion.findMany({
    where: { id: { in: synthMasterIds } },
    select: { id: true, diagramImageData: true },
  });
  const synthMasterById = new Map(synthMasters.map(m => [m.id, m]));

  type SynthFix = { synthId: string; sourceId: string; diagBytes: number };
  const synthFixes: SynthFix[] = [];
  for (const s of missing) {
    const m = synthMasterById.get(s.sourceQuestionId!);
    if (!m) continue;
    const md = m.diagramImageData;
    if (!md || md.length === 0) continue;
    synthFixes.push({ synthId: s.id, sourceId: s.sourceQuestionId!, diagBytes: md.length });
  }

  console.log(`Bank-row fixes:        ${bankFixes.length}`);
  for (const f of bankFixes) console.log(`  ExamQuestion ${f.rowId}  q${f.qNum}  ← ${f.diagBytes} B`);
  console.log(`\nSyntheticQuestion fixes: ${synthFixes.length}`);
  for (const f of synthFixes) console.log(`  SyntheticQuestion ${f.synthId}  source=${f.sourceId}  ← ${f.diagBytes} B`);

  if (DRY) {
    console.log(`\n[DRY RUN] no writes. Re-run without --dry-run to apply.`);
    await prisma.$disconnect();
    return;
  }

  let bankWritten = 0, synthWritten = 0;
  for (const f of bankFixes) {
    const master = bankMasterById.get(bankRows.find(r => r.id === f.rowId)!.sourceQuestionId!)!;
    await prisma.examQuestion.update({
      where: { id: f.rowId },
      data: { diagramImageData: master.diagramImageData },
    });
    bankWritten++;
    console.log(`  ✓ wrote bank row ${f.rowId}`);
  }
  for (const f of synthFixes) {
    const master = synthMasterById.get(f.sourceId)!;
    await prisma.syntheticQuestion.update({
      where: { id: f.synthId },
      data: { diagramImageData: master.diagramImageData },
    });
    synthWritten++;
    console.log(`  ✓ wrote synth ${f.synthId}`);
  }
  console.log(`\nDone. bank=${bankWritten} synth=${synthWritten}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
