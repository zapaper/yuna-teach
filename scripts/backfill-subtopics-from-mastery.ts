// One-shot: propagate subTopic from mastery clones back onto their
// source masters. Sub-topic tagging was done on Mastery papers (e.g.
// "Mastery: Electrical Systems and Circuits Quiz 1"), but the
// lumi-quiz / focused-practice / daily-quiz pickers all filter
// `paperType: null` — they never see those tags. After this backfill
// the source master carries the tag too and pickers can use it.
//
// Safety:
//   · DRY RUN by default. Pass --apply to actually write.
//   · Skip a target master if its current subTopic differs from
//     what mastery suggests (manual review).
//   · Skip a target master if multiple mastery rows disagree on the
//     subTopic for the same source (one conflict known: a Chinese
//     master with [word-meaning, q40-opinion]).

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");

async function main() {
  const masteryRows = await prisma.examQuestion.findMany({
    where: {
      examPaper: { paperType: "mastery" },
      subTopic: { not: null },
      sourceQuestionId: { not: null },
    },
    select: { sourceQuestionId: true, subTopic: true },
  });
  console.log(`Mastery rows with subTopic + source: ${masteryRows.length}`);

  // Group by source — detect conflicts.
  const wantBySource = new Map<string, Set<string>>();
  for (const r of masteryRows) {
    const sid = r.sourceQuestionId!;
    if (!wantBySource.has(sid)) wantBySource.set(sid, new Set());
    wantBySource.get(sid)!.add(r.subTopic!);
  }
  console.log(`Distinct source masters touched: ${wantBySource.size}`);

  const sourceIds = [...wantBySource.keys()];
  const sources = await prisma.examQuestion.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, subTopic: true, syllabusTopic: true, examPaper: { select: { paperType: true, level: true } } },
  });

  let updates = 0, alreadySet = 0, mismatch = 0, conflict = 0;
  const byTopic = new Map<string, number>();
  const toApply: { id: string; subTopic: string }[] = [];

  for (const src of sources) {
    const wants = wantBySource.get(src.id)!;
    if (wants.size > 1) {
      conflict++;
      console.log(`  CONFLICT src=${src.id} mastery says [${[...wants].join(", ")}] — skipping`);
      continue;
    }
    const want = [...wants][0];
    if (src.subTopic === want) {
      alreadySet++;
    } else if (src.subTopic && src.subTopic !== want) {
      mismatch++;
      console.log(`  MISMATCH src=${src.id} current="${src.subTopic}" mastery="${want}" — skipping (manual review)`);
    } else {
      updates++;
      const t = src.syllabusTopic ?? "(none)";
      byTopic.set(t, (byTopic.get(t) ?? 0) + 1);
      toApply.push({ id: src.id, subTopic: want });
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Already correctly tagged: ${alreadySet}`);
  console.log(`  Would propagate: ${updates}`);
  console.log(`  Skipped (mastery-conflict): ${conflict}`);
  console.log(`  Skipped (master already has different subTopic): ${mismatch}`);
  console.log(`\n  By topic:`);
  for (const [t, n] of [...byTopic.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t}: ${n}`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN. Re-run with --apply to write.`);
    return;
  }

  console.log(`\nApplying ${toApply.length} updates…`);
  for (const u of toApply) {
    await prisma.examQuestion.update({
      where: { id: u.id },
      data: { subTopic: u.subTopic },
    });
  }
  console.log(`Done.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
