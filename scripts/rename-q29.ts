// One-off: rename ExamQuestion 29_p2 → Q29b in exam cmpo2q0qo0001sm5jeg874w3r
// and relabel its 3 subparts so they render as (b)(i)..(b)(iii).
//
// Storage convention (src/lib/subpart-label.ts):
//   "b-i"  → "(b)(i)"
//   "b-ii" → "(b)(ii)"
//   "b-iii"→ "(b)(iii)"
//
// Answer string already contains (b)(i)..(b)(iii) labels — leaving untouched.
//
// Run with --apply to commit; dry-run by default.
import { prisma } from "../src/lib/db";

const examId = "cmpo2q0qo0001sm5jeg874w3r";
const apply = process.argv.includes("--apply");

type SubpartShape = { label: string; text: string; refImageBase64?: string | null; diagramBase64?: string | null };

async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: examId, questionNum: "29_p2" },
    select: { id: true, questionNum: true, transcribedSubparts: true, answer: true },
  });

  if (!q) {
    console.log(`No question with questionNum="29_p2" in exam ${examId}.`);
    return;
  }

  const oldSubs = (q.transcribedSubparts ?? []) as unknown as SubpartShape[];
  const relabel: Record<string, string> = { "i": "b-i", "ii": "b-ii", "iii": "b-iii" };
  const newSubs = oldSubs.map(sp => ({ ...sp, label: relabel[sp.label] ?? sp.label }));

  console.log("Current question:");
  console.log(`  id            = ${q.id}`);
  console.log(`  questionNum   = ${q.questionNum}`);
  console.log(`  subpart labels = ${oldSubs.map(s => s.label).join(", ")}`);
  console.log("");
  console.log("Planned update:");
  console.log(`  questionNum   = Q29b`);
  console.log(`  subpart labels = ${newSubs.map(s => s.label).join(", ")} (renders as (b)(i), (b)(ii), (b)(iii))`);
  console.log(`  answer        = (unchanged — already labelled (b)(i)..(b)(iii))`);
  console.log("");

  if (!apply) {
    console.log("DRY RUN. Re-run with --apply to commit.");
    return;
  }

  const res = await prisma.examQuestion.update({
    where: { id: q.id },
    data: {
      questionNum: "Q29b",
      transcribedSubparts: newSubs as unknown as object,
    },
    select: { id: true, questionNum: true },
  });
  console.log(`✅ Updated ${res.id} → questionNum=${res.questionNum}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
