// One-off + re-runnable: AI-tag the `subTopic` field on existing
// ExamQuestion rows so master-class quizzes can pull from them.
//
// Walks every master class that:
//   - has `subTopics` declared in its YAML, AND
//   - does NOT use `practiceStemRegex` (regex-mode classes don't need
//     subTopic tags — the picker selects by stem match), AND
//   - does NOT have a hand-coded classifier registered in
//     STEM_CLASSIFIERS (Circuits / Patterns re-tag at clone time).
//
// For each remaining master class, finds questions in the master-paper
// bank whose `syllabusTopic` matches the master class's `topicLabel`
// and whose `subTopic` is currently NULL, runs them through the AI
// classifier (src/lib/master-class/classify-by-ai.ts), and writes the
// assigned sub-topic ID back to the row.
//
// Idempotent: rows with non-null subTopic are SKIPPED (preserves human
// edits and prior runs). Re-running picks up only what's still null.
//
// Defaults to PSLE-only papers to match the user's recent upload set.
// Pass --all-papers to broaden, --slug=<slug> to target a single master
// class, --dry-run to count without writing.
//
// Usage:
//   npx tsx scripts/backfill-subtopics.ts
//   npx tsx scripts/backfill-subtopics.ts --slug=interactions-environment
//   npx tsx scripts/backfill-subtopics.ts --all-papers
//   npx tsx scripts/backfill-subtopics.ts --dry-run

import { prisma } from "../src/lib/db";
import { listMasterClasses } from "../src/data/master-class";
import { classifyQuestionsForMasterClass } from "../src/lib/master-class/classify-by-ai";

// Slugs that have hand-coded classifiers in src/app/api/master-class/
// [slug]/start-quiz/route.ts — those re-tag at clone time, so we MUST
// NOT backfill them or we'd write tags that get overwritten on the
// next mastery-quiz spawn.
const SLUGS_WITH_CODE_CLASSIFIER = new Set([
  "patterns",
  "electrical-circuits",
]);

type Args = {
  slug?: string;
  allPapers: boolean;
  dryRun: boolean;
};

function parseArgs(): Args {
  const out: Args = { allPapers: false, dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--all-papers") out.allPapers = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--slug=")) out.slug = a.slice("--slug=".length);
    else if (a === "--help" || a === "-h") {
      console.log("usage: npx tsx scripts/backfill-subtopics.ts [--slug=<slug>] [--all-papers] [--dry-run]");
      process.exit(0);
    } else {
      console.warn(`unknown arg: ${a} (use --help)`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const allMasterClasses = listMasterClasses();
  const targets = allMasterClasses.filter(c => {
    if (c.subTopics.length === 0) return false;
    if (c.practiceStemRegex) return false;
    if (SLUGS_WITH_CODE_CLASSIFIER.has(c.slug)) return false;
    if (args.slug && c.slug !== args.slug) return false;
    return true;
  });

  if (targets.length === 0) {
    console.log("No master classes to process (filtered to empty).");
    return;
  }

  console.log(`Backfilling subTopics for ${targets.length} master class(es):`);
  for (const c of targets) console.log(`  - ${c.slug} (subject=${c.subject}, topic=${c.topicLabel})`);
  console.log(`Scope: ${args.allPapers ? "ALL master papers" : "PSLE papers only"} | mode: ${args.dryRun ? "DRY RUN" : "WRITE"}`);
  console.log("");

  const summary: Array<{ slug: string; candidates: number; tagged: number; nulled: number; errored: number }> = [];

  for (const content of targets) {
    const t0 = Date.now();
    const label = `[${content.slug}]`;
    const psleClause = args.allPapers ? {} : {
      OR: [
        { level: { equals: "PSLE", mode: "insensitive" as const } },
        { title: { contains: "PSLE", mode: "insensitive" as const } },
      ],
    };
    const allTopicLabels = [content.topicLabel, ...(content.topicLabelExtras ?? [])];
    const syllabusTopicClause = allTopicLabels.length === 1
      ? { syllabusTopic: { equals: content.topicLabel, mode: "insensitive" as const } }
      : { syllabusTopic: { in: allTopicLabels, mode: "insensitive" as const } };
    const candidates = await prisma.examQuestion.findMany({
      where: {
        ...syllabusTopicClause,
        subTopic: null,
        transcribedStem: { not: null },
        examPaper: {
          sourceExamId: null,
          paperType: null,
          ...psleClause,
        },
      },
      select: {
        id: true,
        questionNum: true,
        transcribedStem: true,
        answer: true,
      },
    });
    if (candidates.length === 0) {
      console.log(`${label} no untagged candidates — skipping`);
      summary.push({ slug: content.slug, candidates: 0, tagged: 0, nulled: 0, errored: 0 });
      continue;
    }
    console.log(`${label} ${candidates.length} untagged candidates → classifying...`);

    const assignments = await classifyQuestionsForMasterClass(content, candidates, {
      logLabel: `[ai ${content.slug}]`,
    });

    let tagged = 0, nulled = 0, errored = 0;
    if (!args.dryRun) {
      for (const [qid, sub] of assignments) {
        try {
          if (sub == null) {
            // Model explicitly returned null — leave subTopic null in
            // the DB (don't overwrite with empty string). Recorded for
            // the audit count.
            nulled++;
            continue;
          }
          await prisma.examQuestion.update({
            where: { id: qid },
            data: { subTopic: sub },
          });
          tagged++;
        } catch (err) {
          errored++;
          console.error(`${label} write failed for ${qid}: ${(err as Error).message}`);
        }
      }
    } else {
      for (const v of assignments.values()) {
        if (v == null) nulled++; else tagged++;
      }
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${label} done in ${dt}s — tagged=${tagged} nulled=${nulled} errored=${errored} (of ${candidates.length} candidates, ${candidates.length - assignments.size} unparsed)`);
    summary.push({ slug: content.slug, candidates: candidates.length, tagged, nulled, errored });
  }

  console.log("\n=== SUMMARY ===");
  console.table(summary);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
