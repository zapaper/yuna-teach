// One-shot fix: the AI extraction for PSLE CHINESE 2016 阅读理解 B OEQ
// passage transposed two characters in the line
//   "红绿灯就是我们的交通警察，驾车的人个个也是交通警察"
// → stored as
//   "红绿灯就是我们的交通警察，驾车的个人个也是交通警察"
// Every test quiz that pulled that section inherited the swap because
// the daily-quiz Chinese branch copies the passage verbatim. Repair
// the master AND every clone in a single pass.
//
// Usage:
//   npx tsx scripts/fix-cn-passage-swap.ts          # dry-run
//   npx tsx scripts/fix-cn-passage-swap.ts --write  # apply

import { prisma } from "../src/lib/db";

const FIXES: Array<{ before: string; after: string }> = [
  { before: "驾车的个人个", after: "驾车的人个个" },
];

async function main() {
  const write = process.argv.includes("--write");
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "chinese", mode: "insensitive" },
    },
    select: { id: true, title: true, metadata: true, paperType: true },
  });

  let touched = 0;
  for (const p of papers) {
    const md = p.metadata as { chineseSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> } | null;
    const cs = md?.chineseSections;
    if (!cs) continue;
    let dirty = false;
    const newSections = cs.map(sec => {
      if (!sec.passage) return sec;
      let p2 = sec.passage;
      for (const { before, after } of FIXES) {
        if (p2.includes(before)) {
          p2 = p2.split(before).join(after);
          dirty = true;
        }
      }
      return p2 === sec.passage ? sec : { ...sec, passage: p2 };
    });
    if (!dirty) continue;
    touched++;
    console.log(`${write ? "WRITE" : "WOULD WRITE"}: ${p.title}  (paperType=${p.paperType ?? "master"})`);
    if (write) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.examPaper.update({
        where: { id: p.id },
        data: { metadata: { ...(md as object), chineseSections: newSections } as any },
      });
    }
  }
  console.log(`\n${write ? "Updated" : "Would update"} ${touched} paper(s).`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
