// Audit: for every master class, count how many tagged questions
// exist per sub-topic, split MCQ vs OEQ. Flags any sub-topic short
// of the minimum needed to fill a mastery quiz.
//
// Master-class quiz spec lives on the first slide's `cta.quizSpec`
// (mcq / oeq targets, optional subTopicOeqMin overrides). The picker
// guarantees at least 1 OEQ per sub-topic (or whatever subTopicOeqMin
// says), so any sub-topic with 0 OEQ silently degrades the quiz.
//
// Usage:
//   npx tsx scripts/audit-master-class-pools.ts
//   npx tsx scripts/audit-master-class-pools.ts --slug=interactions-environment
//   npx tsx scripts/audit-master-class-pools.ts --psle-only

import { prisma } from "../src/lib/db";
import { listMasterClasses } from "../src/data/master-class";

// Slugs with hand-coded classifiers in start-quiz/route.ts. Their
// sub-topic tags are computed at clone time from the stem, so the
// DB subTopic column being null is expected and not a blocker.
const SLUGS_WITH_CODE_CLASSIFIER = new Set<string>([
  "patterns",
  "electrical-circuits",
]);

type Args = { slug?: string; psleOnly: boolean };
function parseArgs(): Args {
  const out: Args = { psleOnly: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--psle-only") out.psleOnly = true;
    else if (a.startsWith("--slug=")) out.slug = a.slice("--slug=".length);
    else if (a === "--help" || a === "-h") {
      console.log("usage: npx tsx scripts/audit-master-class-pools.ts [--slug=<slug>] [--psle-only]");
      process.exit(0);
    }
  }
  return out;
}

// Same MCQ detection used everywhere else in the codebase.
function isMcq(q: {
  transcribedOptions: unknown;
  transcribedOptionImages: unknown;
  transcribedOptionTable: unknown;
}): boolean {
  if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) return true;
  if (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(o => !!o)) return true;
  const t = q.transcribedOptionTable;
  if (t && typeof t === "object" && Array.isArray((t as { rows?: unknown }).rows) && (t as { rows: unknown[] }).rows.length === 4) return true;
  return false;
}

async function main() {
  const args = parseArgs();
  const all = listMasterClasses().filter(c => !args.slug || c.slug === args.slug);

  console.log(`Auditing ${all.length} master class(es). Scope: ${args.psleOnly ? "PSLE only" : "all master papers"}\n`);

  const reports: Array<{
    slug: string;
    quizSpec: { mcq: number; oeq: number; subTopicOeqMin: Record<string, number> };
    rows: Array<{ subTopicId: string; label: string; mcq: number; oeq: number; oeqMin: number; verdict: string }>;
    untagged: number;
    totalTagged: number;
  }> = [];

  for (const c of all) {
    const slides = [...c.keyConcepts, ...(c.commonMistakes ?? [])];
    const quizSpecRaw = slides.map(s => s.cta?.quizSpec).find(Boolean);
    const quizSpec = {
      mcq: quizSpecRaw?.mcq ?? 10,
      oeq: quizSpecRaw?.oeq ?? 6,
      subTopicOeqMin: (quizSpecRaw?.subTopicOeqMin ?? {}) as Record<string, number>,
    };

    const psleClause = args.psleOnly
      ? {
          OR: [
            { level: { equals: "PSLE", mode: "insensitive" as const } },
            { title: { contains: "PSLE", mode: "insensitive" as const } },
          ],
        }
      : {};

    const allTopicLabels = [c.topicLabel, ...(c.topicLabelExtras ?? [])];
    const syllabusTopicClause = allTopicLabels.length === 1
      ? { syllabusTopic: { equals: c.topicLabel, mode: "insensitive" as const } }
      : { syllabusTopic: { in: allTopicLabels, mode: "insensitive" as const } };
    const allQs = await prisma.examQuestion.findMany({
      where: {
        ...syllabusTopicClause,
        examPaper: { sourceExamId: null, paperType: null, ...psleClause },
      },
      select: {
        subTopic: true,
        transcribedOptions: true,
        transcribedOptionImages: true,
        transcribedOptionTable: true,
      },
    });

    // Per-sub-topic tallies + untagged count.
    const byBucket = new Map<string, { mcq: number; oeq: number }>();
    let untagged = 0;
    for (const q of allQs) {
      const bucket = (q.subTopic ?? "").trim();
      if (!bucket) { untagged++; continue; }
      const row = byBucket.get(bucket) ?? { mcq: 0, oeq: 0 };
      if (isMcq(q)) row.mcq++; else row.oeq++;
      byBucket.set(bucket, row);
    }

    // Mode detection — when one of these applies, the sub-topic
    // column being unset is FINE because the picker doesn't gate on
    // it. The verdict logic below collapses to a single "total pool"
    // check instead of per-sub-topic blocking.
    const usesGeneralPool = !!c.noSubTopicFilter;
    const usesCodeClassifier = SLUGS_WITH_CODE_CLASSIFIER.has(c.slug);
    const usesRegexMatcher = !!c.practiceStemRegex;
    const totalPoolSize = allQs.length;
    if (usesGeneralPool || usesCodeClassifier || usesRegexMatcher) {
      // Skip per-sub-topic breakdown — just verify the total pool is
      // adequate. Threshold = the quiz spec total (mcq + oeq).
      const target = quizSpec.mcq + quizSpec.oeq;
      const mcqInPool = allQs.filter(isMcq).length;
      const oeqInPool = totalPoolSize - mcqInPool;
      const matchMode = usesRegexMatcher ? "regex" : (usesCodeClassifier ? "code-classifier" : "general-pool");
      let verdict = "OK";
      if (totalPoolSize === 0) verdict = "BLOCKING (empty pool)";
      else if (mcqInPool < quizSpec.mcq) verdict = `THIN (only ${mcqInPool} MCQ vs spec ${quizSpec.mcq})`;
      else if (quizSpec.oeq > 0 && oeqInPool < quizSpec.oeq) verdict = `THIN (only ${oeqInPool} OEQ vs spec ${quizSpec.oeq})`;
      else if (totalPoolSize < target) verdict = `THIN (only ${totalPoolSize} total vs spec ${target})`;
      const singleRow = [{ subTopicId: `(${matchMode})`, label: `Total pool (no per-sub-topic gating)`, mcq: mcqInPool, oeq: oeqInPool, oeqMin: 0, verdict }];
      reports.push({ slug: c.slug, quizSpec, rows: singleRow, untagged: 0, totalTagged: totalPoolSize });
      continue;
    }
    const rows: Array<{ subTopicId: string; label: string; mcq: number; oeq: number; oeqMin: number; verdict: string }> = [];
    for (const st of c.subTopics) {
      const t = byBucket.get(st.id) ?? { mcq: 0, oeq: 0 };
      const oeqMin = Math.max(1, quizSpec.subTopicOeqMin[st.id] ?? 1);
      const isMcqOnlyQuiz = quizSpec.oeq === 0;
      let verdict = "OK";
      if (isMcqOnlyQuiz) {
        // MCQ-only quiz spec — OEQ count is irrelevant. Need enough
        // MCQs to fill the slot (rough rule: at least 3 to avoid every
        // quiz showing the same one).
        if (t.mcq === 0) verdict = "BLOCKING (no MCQ — MCQ-only quiz)";
        else if (t.mcq < 3) verdict = `WEAK (only ${t.mcq} MCQ)`;
      } else {
        if (t.oeq === 0) verdict = "BLOCKING (no OEQ)";
        else if (t.oeq < oeqMin) verdict = `THIN (oeq=${t.oeq} < min ${oeqMin})`;
        else if (t.mcq + t.oeq < 3) verdict = `WEAK (only ${t.mcq + t.oeq} total)`;
      }
      rows.push({ subTopicId: st.id, label: st.label, mcq: t.mcq, oeq: t.oeq, oeqMin, verdict });
    }

    const totalTagged = rows.reduce((s, r) => s + r.mcq + r.oeq, 0);
    reports.push({ slug: c.slug, quizSpec, rows, untagged, totalTagged });
  }

  // Per-master-class detail.
  for (const r of reports) {
    console.log(`\n========== ${r.slug} ==========`);
    console.log(`  quiz spec: ${r.quizSpec.mcq} MCQ + ${r.quizSpec.oeq} OEQ`);
    console.log(`  pool: tagged=${r.totalTagged}, untagged=${r.untagged}`);
    if (r.rows.length === 0) { console.log(`  (no sub-topics declared)`); continue; }
    const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
    console.log(`  ${w("sub-topic", 30)} ${w("label", 36)} mcq oeq min  verdict`);
    for (const row of r.rows) {
      console.log(`  ${w(row.subTopicId, 30)} ${w(row.label, 36)} ${String(row.mcq).padStart(3)} ${String(row.oeq).padStart(3)} ${String(row.oeqMin).padStart(3)}  ${row.verdict}`);
    }
  }

  // Headline at the end so it's not lost in the per-class scroll.
  console.log(`\n========== HEADLINE ==========`);
  for (const r of reports) {
    const issues = r.rows.filter(row => row.verdict !== "OK");
    if (issues.length === 0) {
      console.log(`  ✅ ${r.slug}: all ${r.rows.length} sub-topic(s) OK (tagged=${r.totalTagged})`);
    } else {
      const blockers = issues.filter(i => i.verdict.startsWith("BLOCKING")).length;
      const thin = issues.filter(i => !i.verdict.startsWith("BLOCKING")).length;
      console.log(`  ${blockers > 0 ? "❌" : "⚠️"} ${r.slug}: ${blockers} blocking, ${thin} thin / weak (tagged=${r.totalTagged}, untagged=${r.untagged})`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
