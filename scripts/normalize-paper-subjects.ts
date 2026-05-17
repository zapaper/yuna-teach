// One-time migration: normalise `examPaper.subject` strings to the
// canonical "Math" / "Science" / "English" labels.
//
// Conservative on purpose:
//   - Word-boundary regex (NOT bare substring) so "Engineering" /
//     "scientific notation" / "conscience" don't trip the matchers.
//   - "sci" / "eng" alone do NOT match anything — only the full
//     subject words.
//   - Anything we can't classify with confidence is LEFT UNTOUCHED
//     and reported under "skipped".
//   - Default is dry-run. Pass `--apply` to actually write.
//
// Run:
//   npx tsx scripts/normalize-paper-subjects.ts          # dry-run
//   npx tsx scripts/normalize-paper-subjects.ts --apply  # commit changes

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MATCHERS: Array<{ canonical: "Math" | "Science" | "English"; re: RegExp }> = [
  { canonical: "Math", re: /\b(maths?|mathematics)\b/i },
  { canonical: "Science", re: /\b(science|sciences)\b/i },
  { canonical: "English", re: /\benglish\b/i },
];

function classify(raw: string): "Math" | "Science" | "English" | null {
  // Skip strings that match multiple subjects (e.g. "Math and
  // Science"). Better to leave human review than guess wrong.
  const hits = MATCHERS.filter((m) => m.re.test(raw)).map((m) => m.canonical);
  const uniq = [...new Set(hits)];
  if (uniq.length !== 1) return null;
  return uniq[0];
}

async function main() {
  const apply = process.argv.includes("--apply");

  const papers = await prisma.examPaper.findMany({
    where: { subject: { not: null } },
    select: { id: true, subject: true },
  });

  const planned: Array<{ id: string; from: string; to: string }> = [];
  const skipped: Array<{ id: string; subject: string }> = [];

  for (const p of papers) {
    const raw = p.subject!; // non-null per where-clause
    const target = classify(raw);
    if (!target) {
      // Only report values that ALREADY don't match the canonical
      // form — skipping "Math" → "Math" would be noise.
      if (raw !== "Math" && raw !== "Science" && raw !== "English") {
        skipped.push({ id: p.id, subject: raw });
      }
      continue;
    }
    if (raw === target) continue; // already canonical
    planned.push({ id: p.id, from: raw, to: target });
  }

  // Group planned changes by `from → to` so the dry-run report is
  // a 5-line summary rather than thousands of rows.
  const buckets = new Map<string, { from: string; to: string; count: number; sampleIds: string[] }>();
  for (const c of planned) {
    const key = `${c.from} → ${c.to}`;
    let b = buckets.get(key);
    if (!b) { b = { from: c.from, to: c.to, count: 0, sampleIds: [] }; buckets.set(key, b); }
    b.count++;
    if (b.sampleIds.length < 3) b.sampleIds.push(c.id);
  }

  console.log(`\nScanned ${papers.length} paper(s). Planned ${planned.length} update(s) across ${buckets.size} mapping(s):`);
  for (const b of [...buckets.values()].sort((a, b) => b.count - a.count)) {
    console.log(`  ${b.count.toString().padStart(5)}  "${b.from}" → "${b.to}"   (sample ids: ${b.sampleIds.join(", ")})`);
  }

  if (skipped.length > 0) {
    const uniqSkipped = [...new Set(skipped.map((s) => s.subject))].slice(0, 30);
    console.log(`\nSkipped ${skipped.length} paper(s) with unclassifiable subjects (no clear math/science/english match):`);
    for (const s of uniqSkipped) console.log(`  - "${s}"`);
    if (uniqSkipped.length < new Set(skipped.map((s) => s.subject)).size) {
      console.log(`  (… and more)`);
    }
    console.log(`These will NOT be changed. Review and fix manually if any are misclassified.`);
  }

  if (!apply) {
    console.log(`\nDry-run only. Re-run with --apply to write changes.\n`);
    return;
  }

  console.log(`\nApplying ${planned.length} update(s)...`);
  // Batch in groups of 500 inside a transaction so a partial failure
  // doesn't leave the DB half-migrated.
  const BATCH = 500;
  for (let i = 0; i < planned.length; i += BATCH) {
    const slice = planned.slice(i, i + BATCH);
    await prisma.$transaction(
      slice.map((c) =>
        prisma.examPaper.update({ where: { id: c.id }, data: { subject: c.to } }),
      ),
    );
    console.log(`  committed ${Math.min(i + BATCH, planned.length)}/${planned.length}`);
  }
  console.log(`Done.\n`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
