import { prisma } from "../src/lib/db";
const PAPER = "cmq37j4pf003jrnvdeyrepryo";
async function main() {
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, title: true, subject: true, metadata: true, createdAt: true, paperType: true },
  });
  console.log("Paper:", JSON.stringify({ id: p?.id, title: p?.title, subject: p?.subject, paperType: p?.paperType, createdAt: p?.createdAt }, null, 2));
  const meta = p?.metadata as Record<string, unknown> | null;
  console.log("masterClassSlug:", meta?.masterClassSlug);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, orderIndex: true, subTopic: true,
      marksAvailable: true,
      transcribedStem: true, transcribedOptions: true, transcribedSubparts: true,
    },
  });
  console.log(`\n${qs.length} questions:`);
  for (const q of qs) {
    console.log(`\n--- Q${q.questionNum}  idx=${q.orderIndex}  subTopic=${q.subTopic}  marks=${q.marksAvailable} ---`);
    const stem = q.transcribedStem ?? "";
    console.log("stem (raw, JSON-encoded to show invisibles):");
    console.log(JSON.stringify(stem.slice(0, 500)));
    // Check what hasInlineLineMarkers WOULD trip on
    const linesMatch = stem.match(/\[(?:Lines?:\s*)?(\d+)\s*(?:lines?)?\]/i);
    const tripUnderscore = /^_{3,}\s*$/m.test(stem);
    const tripTickBox = /\[[ x✓✗]\]/i.test(stem);
    console.log(`hasInlineLineMarkers triggers: linesMatch=${!!linesMatch} ${linesMatch ? JSON.stringify(linesMatch[0]) : ""}  underscore=${tripUnderscore}  tickbox=${tripTickBox}`);
  }
  process.exit(0);
}
main();
