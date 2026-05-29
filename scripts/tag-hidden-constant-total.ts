// Targeted backfill: walks Math PSLE + P6 questions, runs each through
// the hidden-constant-total stem classifier, and writes the resulting
// subTopic ID to the DB row. Mirrors classify-hidden-constant-total.ts
// so source rows can be inspected/audited and the master-class picker's
// `q.subTopic` short-circuit fires (no need to re-classify at quiz time).
//
// Re-runnable; skips rows that already have a non-null subTopic so a
// human edit isn't overwritten.
//
// Usage:
//   npx tsx scripts/tag-hidden-constant-total.ts            (dry-run)
//   npx tsx scripts/tag-hidden-constant-total.ts --write    (live)

import { prisma } from "../src/lib/db";
import { classifyHiddenConstantTotal } from "../src/lib/master-class/classify-hidden-constant-total";

async function main() {
  const write = process.argv.includes("--write");
  console.log(`Mode: ${write ? "WRITE" : "DRY-RUN"}\n`);

  const qs = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      subTopic: null,
      examPaper: {
        sourceExamId: null, paperType: null,
        subject: { contains: "math", mode: "insensitive" },
        OR: [
          { level: { equals: "PSLE", mode: "insensitive" } },
          { level: { in: ["P6", "Primary 6", "6"] } },
          { title: { contains: "PSLE", mode: "insensitive" } },
        ],
      },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      examPaper: { select: { title: true, year: true } },
    },
  });
  console.log(`Math PSLE + P6 unkeyed candidates: ${qs.length}\n`);

  const buckets = { "internal-transfer": [] as typeof qs, "equalise-ratios": [] as typeof qs };
  for (const q of qs) {
    const sub = classifyHiddenConstantTotal(q.transcribedStem);
    if (sub === "internal-transfer" || sub === "equalise-ratios") {
      buckets[sub].push(q);
    }
  }

  for (const sub of Object.keys(buckets) as Array<keyof typeof buckets>) {
    const list = buckets[sub];
    console.log(`${sub}: ${list.length} match(es)`);
    list.forEach((q, i) => {
      console.log(`  ${(i + 1).toString().padStart(2, "0")} [${q.examPaper.title}${q.examPaper.year ? ` ${q.examPaper.year}` : ""}] Q${q.questionNum} (id=${q.id.slice(0, 12)})`);
      console.log(`      ${(q.transcribedStem ?? "").trim().replace(/\s+/g, " ").slice(0, 200)}…`);
    });
    console.log();
  }

  if (!write) {
    const total = buckets["internal-transfer"].length + buckets["equalise-ratios"].length;
    console.log(`DRY_RUN — would tag ${total} row(s). Re-run with --write to apply.`);
    return;
  }

  let tagged = 0;
  for (const sub of Object.keys(buckets) as Array<keyof typeof buckets>) {
    for (const q of buckets[sub]) {
      try {
        await prisma.examQuestion.update({ where: { id: q.id }, data: { subTopic: sub } });
        tagged++;
      } catch (err) {
        console.error(`write failed ${q.id}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`Tagged ${tagged} row(s).`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
