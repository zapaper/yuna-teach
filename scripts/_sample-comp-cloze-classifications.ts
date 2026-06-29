// 10 random samples per sub-topic bucket so the user can sanity-check
// the Comp Cloze classifier before we --apply.
import { prisma } from "@/lib/db";
import { classifyCompCloze, type CompClozeSubTopic } from "@/lib/master-class/classify-comp-cloze";

const SHOW_PER_BUCKET = 2;
const BUCKETS: CompClozeSubTopic[] = ["connector", "preposition", "pronoun-reference", "subject-verb-agreement", "content-word"];

async function main() {
  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Comprehension Cloze",
      answer: { not: null },
      examPaper: {
        subject: { equals: "English", mode: "insensitive" },
        sourceExamId: null,
        OR: [
          { title: { contains: "PSLE", mode: "insensitive" } },
          { level: { contains: "6", mode: "insensitive" } },
        ],
      },
    },
    select: { id: true, transcribedStem: true, answer: true },
  });

  const groups = new Map<CompClozeSubTopic, Array<typeof candidates[number]>>();
  for (const b of BUCKETS) groups.set(b, []);
  let nullCount = 0;
  for (const q of candidates) {
    const r = classifyCompCloze(q.transcribedStem, q.answer);
    if (r === null) { nullCount++; continue; }
    groups.get(r)!.push(q);
  }

  for (const b of BUCKETS) {
    const arr = groups.get(b)!;
    console.log(`\n── ${b.toUpperCase()} (${arr.length} hits, showing ${Math.min(SHOW_PER_BUCKET, arr.length)}) ──`);
    // Random shuffle then slice
    const shuffled = [...arr].sort(() => Math.random() - 0.5).slice(0, SHOW_PER_BUCKET);
    for (const q of shuffled) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 180);
      console.log(`  [${q.id.slice(-6)}] answer: "${q.answer}"  stem: ${stem}`);
    }
  }
  console.log(`\nUnclassified (null): ${nullCount}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
