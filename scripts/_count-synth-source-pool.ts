import { prisma } from "../src/lib/db";

const ENGLISH_SYN = ["Synthesis / Transformation", "Synthesis & Transformation"];

async function main() {
  console.log("=== Where do the 1257 English Synthesis questions live? ===\n");
  const all = await prisma.examQuestion.count({
    where: { syllabusTopic: { in: ENGLISH_SYN } },
  });
  console.log(`Total tagged English Synthesis: ${all}`);

  // 1) On MASTER papers (sourceExamId=null AND paperType=null), excluding the synth bank.
  const masterNotBank = await prisma.examQuestion.count({
    where: {
      syllabusTopic: { in: ENGLISH_SYN },
      examPaper: {
        sourceExamId: null, paperType: null,
        NOT: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
    },
  });
  console.log(`  On master English papers (the source pool): ${masterNotBank}`);

  // 2) On the synth bank itself.
  const bank = await prisma.examQuestion.count({
    where: {
      syllabusTopic: { in: ENGLISH_SYN },
      examPaper: { OR: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }] },
    },
  });
  console.log(`  On [Synthetic Bank] (accepted variants): ${bank}`);

  // 3) On non-master papers (assigned papers, focused tests, daily quizzes, mastery clones, etc.).
  const nonMaster = await prisma.examQuestion.count({
    where: {
      syllabusTopic: { in: ENGLISH_SYN },
      examPaper: {
        OR: [
          { sourceExamId: { not: null } },
          { paperType: { not: null } },
        ],
      },
    },
  });
  console.log(`  On clones / quizzes / focused / mastery: ${nonMaster}  ← these are STUDENT-ATTEMPT clones, not source rows`);

  console.log("\n=== Master-source pool: state breakdown ===");
  const masterRows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ENGLISH_SYN },
      examPaper: {
        sourceExamId: null, paperType: null,
        NOT: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
    },
    select: {
      transcribedStem: true, answer: true, subTopic: true,
      syntheticGenerated: true, syntheticSkipped: true,
    },
  });
  let hasStem = 0, hasAns = 0, both = 0, tagged = 0, untagged = 0, generated = 0, skipped = 0, qualityPending = 0;
  for (const r of masterRows) {
    if (r.transcribedStem) hasStem++;
    if (r.answer) hasAns++;
    if (r.transcribedStem && r.answer) both++;
    if (r.subTopic) tagged++; else untagged++;
    if (r.syntheticGenerated) generated++;
    if (r.syntheticSkipped) skipped++;
    const words = (r.answer ?? "").trim().split(/\s+/).filter(Boolean);
    if (!r.syntheticGenerated && words.length >= 5 && r.transcribedStem) qualityPending++;
  }
  console.log(`Total master rows: ${masterRows.length}`);
  console.log(`  has transcribedStem: ${hasStem}`);
  console.log(`  has answer:          ${hasAns}`);
  console.log(`  has both:            ${both}`);
  console.log(`  has subTopic tag:    ${tagged}  (untagged: ${untagged})`);
  console.log(`  syntheticGenerated:  ${generated}  (already used)`);
  console.log(`  syntheticSkipped:    ${skipped}`);
  console.log(`  Quality-pending (≥5 words, not yet generated, has stem): ${qualityPending}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
