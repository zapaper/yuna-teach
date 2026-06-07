import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmpufpq4m000111bmp5t0lg85";
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, title: true, paperType: true, metadata: true },
  });
  if (!paper) { console.log("not found"); return; }
  console.log(`paper: ${paper.title}  type=${paper.paperType}`);
  const md = (paper.metadata ?? {}) as Record<string, unknown>;
  console.log(`metadata keys: ${Object.keys(md).join(", ")}`);
  console.log(`masterClassSlug: ${md.masterClassSlug}`);

  // Sections
  const sections = (md.chineseSections ?? md.englishSections ?? []) as Array<Record<string, unknown>>;
  console.log(`\nsections (${sections.length}):`);
  for (const s of sections) {
    console.log(`  ${s.label}  startIndex=${s.startIndex} endIndex=${s.endIndex}  passage=${typeof s.passage === "string" ? (s.passage as string).length : "none"} chars`);
  }

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, syllabusTopic: true },
  });
  console.log(`\n${qs.length} questions:`);
  for (const q of qs) {
    const opts = q.transcribedOptions as string[] | null;
    const stem = (q.transcribedStem ?? "").slice(0, 80);
    console.log(`  Q${q.questionNum}  ans=${q.answer}  topic=${q.syllabusTopic}`);
    console.log(`    stem: ${stem}`);
    if (opts) {
      for (let i = 0; i < opts.length; i++) {
        console.log(`    (${i+1}) ${opts[i].slice(0, 60)}`);
      }
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
