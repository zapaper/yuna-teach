// Audits master exam papers for metadata issues found in UA testing:
//   B-09: title says "SA1" but examType says "WA2" (and vice versa)
//   B-10: reports count of papers per level (expect P4/P5/P6 coverage)
//
// Run with:  npx tsx scripts/audit-paper-metadata.ts
// Pass --fix to auto-correct examType from the title where mismatch is clear.

import { prisma } from "@/lib/db";

const KNOWN_EXAM_TYPES = ["WA1", "WA2", "WA3", "SA1", "SA2", "CA1", "CA2", "End of Year", "Preliminary", "Synthetic"] as const;

function extractExamTypeFromTitle(title: string): string | null {
  const upper = title.toUpperCase();
  for (const t of KNOWN_EXAM_TYPES) {
    const u = t.toUpperCase();
    const re = new RegExp(`\\b${u.replace(/ /g, "\\s+")}\\b`);
    if (re.test(upper)) return t;
  }
  return null;
}

async function main() {
  const fix = process.argv.includes("--fix");

  const masters = await prisma.examPaper.findMany({
    where: { paperType: null, sourceExamId: null, assignedToId: null },
    select: { id: true, title: true, subject: true, examType: true, level: true },
  });

  console.log(`\nAudited ${masters.length} master paper(s).\n`);

  // Level coverage (B-10)
  const byLevel: Record<string, number> = {};
  for (const p of masters) {
    const key = p.level ?? "(null)";
    byLevel[key] = (byLevel[key] ?? 0) + 1;
  }
  console.log("Papers by level:");
  for (const [lvl, n] of Object.entries(byLevel).sort()) {
    console.log(`  ${lvl}: ${n}`);
  }
  console.log("");

  // examType vs title mismatches (B-09)
  const mismatches = [] as { id: string; title: string; current: string | null; suggested: string }[];
  for (const p of masters) {
    const suggested = extractExamTypeFromTitle(p.title);
    if (!suggested) continue;
    if ((p.examType ?? "").toLowerCase() !== suggested.toLowerCase()) {
      mismatches.push({ id: p.id, title: p.title, current: p.examType, suggested });
    }
  }

  if (mismatches.length === 0) {
    console.log("No examType/title mismatches found.\n");
    return;
  }

  console.log(`Found ${mismatches.length} mismatch(es):`);
  for (const m of mismatches) {
    console.log(`  [${m.id}] "${m.title}" — examType="${m.current}" → "${m.suggested}"`);
  }
  console.log("");

  if (fix) {
    for (const m of mismatches) {
      await prisma.examPaper.update({ where: { id: m.id }, data: { examType: m.suggested } });
    }
    console.log(`Fixed ${mismatches.length} paper(s).\n`);
  } else {
    console.log("Re-run with --fix to apply corrections.\n");
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
