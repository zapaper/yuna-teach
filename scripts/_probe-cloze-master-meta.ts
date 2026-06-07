// Inspect chineseSectionsMeta on the cloze master quiz — specifically
// startIndex/endIndex per section vs actual question count.

import { prisma } from "../src/lib/db";

async function main() {
  const paper = await prisma.examPaper.findFirst({
    where: {
      paperType: { in: ["quiz", "mastery"] },
      title: { contains: "短文填空", mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, metadata: true },
  });
  if (!paper) { console.log("not found"); return; }
  console.log(`paper: ${paper.title} (${paper.id})`);
  const md = (paper.metadata ?? {}) as Record<string, unknown>;
  // List all metadata keys + sections key shapes
  console.log(`\nmetadata keys: ${Object.keys(md).join(", ")}`);

  const candidates: string[] = ["chineseSections", "englishSections", "sections", "chineseSectionsMeta"];
  for (const key of candidates) {
    const v = md[key];
    if (Array.isArray(v)) {
      console.log(`\nmetadata.${key} (${v.length} sections):`);
      for (const sec of v as Record<string, unknown>[]) {
        const label = String(sec.label ?? sec.name ?? "?");
        const startIdx = sec.startIndex;
        const endIdx = sec.endIndex;
        const passageLen = typeof sec.passage === "string" ? (sec.passage as string).length : "no";
        const blankCount = typeof sec.passage === "string"
          ? ((sec.passage as string).match(/\*\*[^*]*\*\*/g) ?? []).length
          : 0;
        console.log(`  ${label.padEnd(28)} startIndex=${startIdx} endIndex=${endIdx}  passage=${passageLen} chars, ${blankCount} blanks`);
      }
    }
  }

  const qCount = await prisma.examQuestion.count({ where: { examPaperId: paper.id } });
  console.log(`\nactual question count: ${qCount}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
