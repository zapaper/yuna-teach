import { prisma } from "@/lib/db";
async function main() {
  const sample = await prisma.examQuestion.findFirst({
    where: {
      syllabusTopic: "Grammar Cloze",
      answer: { not: null },
      examPaper: {
        sourceExamId: null,
        OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { contains: "6", mode: "insensitive" } }],
      },
    },
    select: { examPaperId: true, answer: true },
  });
  if (!sample) return;
  const paper = await prisma.examPaper.findUnique({ where: { id: sample.examPaperId }, select: { metadata: true, title: true } });
  console.log(`Paper: ${paper?.title}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (paper?.metadata ?? {}) as any;
  console.log(`metadata keys: ${Object.keys(meta).join(", ")}\n`);
  // Try a few likely paths
  for (const key of Object.keys(meta)) {
    const v = meta[key];
    if (typeof v === "string" && /\b(A|B|C)\b/.test(v) && v.length > 200) {
      console.log(`── metadata.${key} (${v.length} chars) ──`);
      console.log(v.slice(0, 800));
      break;
    }
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      console.log(`── metadata.${key} (array of ${v.length}) ──`);
      console.log(JSON.stringify(v[0], null, 2).slice(0, 800));
    }
  }
  // Also peek at the question stems for this section — see if the
  // bank lives in the stem of an early question or in a section
  // header that came through differently.
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: sample.examPaperId, syllabusTopic: "Grammar Cloze" },
    select: { questionNum: true, transcribedStem: true, answer: true },
    orderBy: { orderIndex: "asc" },
    take: 5,
  });
  console.log(`\n── first 5 Grammar Cloze Qs in this paper ──`);
  for (const q of qs) {
    console.log(`  Q${q.questionNum} ans=${q.answer}  stem: ${(q.transcribedStem ?? "(empty)").replace(/\s+/g, " ").slice(0, 200)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
