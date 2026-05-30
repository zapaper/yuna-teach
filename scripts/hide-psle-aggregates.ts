// Hide the 4 PSLE Science aggregate / compilation papers
// (2022-2024 Life / Physical Science MCQ + OEQ) from the Set Papers
// list. These are admin-curated compilations, not single year papers,
// and they shouldn't surface to parents alongside year-by-year PSLE
// papers.
//
// Usage:
//   npx tsx scripts/hide-psle-aggregates.ts          # dry-run
//   npx tsx scripts/hide-psle-aggregates.ts --write  # apply

import { prisma } from "../src/lib/db";

const TITLE_PATTERNS = [
  "PSLE Life Science MCQ 2022-2024",
  "PSLE Life Science OEQ 2022-2024",
  "PSLE Physical Science MCQ 2022-2024",
  "PSLE Physical science OEQ 2022-2024",
];

async function main() {
  const write = process.argv.includes("--write");
  for (const t of TITLE_PATTERNS) {
    const rows = await prisma.examPaper.findMany({
      where: { title: { equals: t, mode: "insensitive" } },
      select: { id: true, title: true, subject: true, visible: true },
    });
    if (rows.length === 0) {
      console.log(`(no match) ${t}`);
      continue;
    }
    for (const r of rows) {
      console.log(`${write ? "HIDE" : "WOULD HIDE"}  id=${r.id}  visible(was)=${r.visible}  title="${r.title}"`);
      if (write) {
        await prisma.examPaper.update({ where: { id: r.id }, data: { visible: false } });
      }
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
