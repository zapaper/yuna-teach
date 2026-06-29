// Fix the source paper Q8 answer for P5 Science WA1 Nanyang 2025.
// Issues:
//   1. Text uses "Part (bii)" — should be "Part (b)(ii)" so the
//      auto-solve trigger recognises the subpart properly.
//   2. transcribedSubparts has the b-ii content stuffed into b-i's
//      answer field. Split them so b-ii has its own answer.
//
// Also clears the [solve on demand] marking note on the affected
// clone(s) and copies the cleaned source answer back to them — so
// when the next remark runs, the clone marks against the proper key.
//
// Dry-run by default; pass --apply to write.

import { prisma } from "@/lib/db";

const SOURCE_Q_ID = "cmnpnhr11000jt0o2fldbamin";

const NEW_ANSWER =
  "Part (a): X: Wind | Y: Animal. | " +
  "Part (b)(i): see answer image. Bar chart for Z should show average lower than X or Y. | " +
  "Part (b)(ii): Fruit of Z is pod-like and the seeds are scattered closest to the parent plant and will not be dispersed as far as fruits of X and Y.";

const NEW_SUBPARTS = [
  { label: "a", text: "Identify the method of seed dispersal for plant X and Y. [1marks]", refImageBase64: null },
  {
    label: "b-i",
    text: "The graph below shows the average distance between the locations of the young plants of X, Y and Z, and their parent plants. The graphs of fruits X and Y has been drawn for you.\nIn the graph above, complete the bar graph by drawing the average distance between young plants of Z and their parent plants. [1marks]",
    answer: "see answer image. Bar chart for Z should show average lower than X or Y.",
    refImageBase64: null,
  },
  {
    label: "b-ii",
    text: "Explain the answer for (b) (i) based on the characteristics of the fruit of Z. [2marks]",
    answer: "Fruit of Z is pod-like and the seeds are scattered closest to the parent plant and will not be dispersed as far as fruits of X and Y.",
    refImageBase64: null,
  },
];

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "── APPLY mode ──\n" : "── DRY RUN (pass --apply to commit) ──\n");

  const src = await prisma.examQuestion.findUnique({
    where: { id: SOURCE_Q_ID },
    select: { id: true, answer: true, transcribedSubparts: true, examPaper: { select: { title: true } } },
  });
  if (!src) { console.log("source not found"); return; }
  console.log(`Source: ${src.examPaper.title}\n`);
  console.log(`  OLD answer:\n    ${src.answer}\n`);
  console.log(`  NEW answer:\n    ${NEW_ANSWER}\n`);

  // Find all clones of this source question
  const clones = await prisma.examQuestion.findMany({
    where: { sourceQuestionId: SOURCE_Q_ID },
    select: { id: true, markingNotes: true, examPaper: { select: { id: true, title: true } } },
  });
  console.log(`Clones: ${clones.length}`);
  for (const c of clones) {
    const flagged = (c.markingNotes ?? "").includes("[solve on demand]");
    console.log(`  ${c.id}  ${c.examPaper.title}  ${flagged ? "[solve-on-demand]" : ""}`);
  }

  if (apply) {
    // Update source
    await prisma.examQuestion.update({
      where: { id: SOURCE_Q_ID },
      data: { answer: NEW_ANSWER, transcribedSubparts: NEW_SUBPARTS },
    });
    console.log(`\n  Updated source Q answer + subparts.`);
    // Update clones: clear marking note + adopt the clean answer/subparts
    let cn = 0;
    for (const c of clones) {
      await prisma.examQuestion.update({
        where: { id: c.id },
        data: {
          answer: NEW_ANSWER,
          transcribedSubparts: NEW_SUBPARTS,
          markingNotes: null,
        },
      });
      cn++;
    }
    console.log(`  Reset ${cn} clones (answer / subparts / markingNotes).`);
  } else {
    console.log(`\n  Pass --apply to write.`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
