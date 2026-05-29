// Tag PSLE Chinese 完成对话 (Q26-Q29) source questions with the
// q26-q29-dialogue sub-topic so the chinese-sentence-completion master
// class's mastery quiz can pull them.
//
// Rule: when syllabusTopic equals "完成对话" on a Chinese master paper,
// the question IS dialogue completion by extraction's own classification
// — no AI call needed, just set subTopic. Re-runnable; skips rows that
// already have a subTopic set so a human edit isn't overwritten.
//
// Optional broader catch: also tag questions in Chinese papers whose
// questionNum starts with 26/27/28/29 (the standard PSLE dialogue slot)
// — only when their syllabusTopic looks Chinese-section-ish AND
// subTopic is still null.
//
// Usage:
//   npx tsx scripts/tag-chinese-dialogue.ts
//   npx tsx scripts/tag-chinese-dialogue.ts --dry-run

import { prisma } from "../src/lib/db";

async function main() {
  const dry = process.argv.includes("--dry-run");

  // Path 1 — extraction tagged it 完成对话 directly.
  const byTopic = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { equals: "完成对话", mode: "insensitive" },
      subTopic: null,
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "chinese", mode: "insensitive" },
      },
    },
    select: { id: true, questionNum: true, examPaper: { select: { title: true, level: true } } },
  });
  console.log(`Path 1 (syllabusTopic="完成对话"): ${byTopic.length} candidate(s)`);

  // Path 2 — fallback by question number on Chinese papers (Q26-Q29).
  // Only applies when extraction didn't pin 完成对话 explicitly.
  const byNum = await prisma.examQuestion.findMany({
    where: {
      questionNum: { in: ["26", "27", "28", "29"] },
      subTopic: null,
      syllabusTopic: { not: "完成对话", mode: "insensitive" },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "chinese", mode: "insensitive" },
        OR: [
          { level: { equals: "PSLE", mode: "insensitive" } },
          { level: { in: ["P6", "Primary 6", "6"] } },
          { title: { contains: "PSLE", mode: "insensitive" } },
        ],
      },
    },
    select: { id: true, questionNum: true, examPaper: { select: { title: true, level: true } } },
  });
  console.log(`Path 2 (Q26-Q29 by questionNum, Chinese PSLE/P6): ${byNum.length} candidate(s)`);

  const all = [...byTopic, ...byNum];
  if (all.length === 0) {
    console.log("No candidates — nothing to tag.");
    return;
  }

  // Surface a per-paper summary so you can spot any oddity before
  // writing. PSLE 2016-2025 should each contribute ~4 questions.
  const perPaper = new Map<string, number>();
  for (const q of all) {
    const key = `${q.examPaper.title} [${q.examPaper.level ?? "?"}]`;
    perPaper.set(key, (perPaper.get(key) ?? 0) + 1);
  }
  console.log("\nPer paper:");
  for (const [k, v] of [...perPaper.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${v.toString().padStart(3)}  ${k}`);
  }

  if (dry) {
    console.log(`\nDRY_RUN — would tag ${all.length} question(s) as subTopic="q26-q29-dialogue".`);
    return;
  }

  let written = 0;
  for (const q of all) {
    try {
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { subTopic: "q26-q29-dialogue" },
      });
      written++;
    } catch (err) {
      console.error(`write failed for ${q.id} (Q${q.questionNum}): ${(err as Error).message}`);
    }
  }
  console.log(`\nTagged ${written} of ${all.length}.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
