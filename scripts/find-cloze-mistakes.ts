// Find recent Comp Cloze mistakes by david lim, mark lim, shadow demon
// where the student wrote a word that needs a DIFFERENT preposition than
// what's in the passage — feeds the worked example slide.
import { prisma } from "../src/lib/db";

const NAME_PATTERNS = ["david lim", "mark lim", "shadow demon"];

async function main() {
  const users = await prisma.user.findMany({
    where: {
      OR: NAME_PATTERNS.flatMap(p => [
        { name: { contains: p, mode: "insensitive" as const } },
        { displayName: { contains: p, mode: "insensitive" as const } },
      ]),
      role: "STUDENT",
    },
    select: { id: true, name: true, displayName: true },
  });
  console.log(`Students found: ${users.length}`);
  for (const u of users) console.log(`  ${u.id}  name="${u.name}" display="${u.displayName ?? ""}"`);

  if (users.length === 0) return;

  // Pull every Comp Cloze question they attempted (last 30 days) that
  // got <full marks. Show the answer key, what they wrote, and the
  // marking notes.
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: { in: users.map(u => u.id) },
        completedAt: { gt: since, not: null },
      },
      syllabusTopic: "Comprehension Cloze",
      marksAwarded: { lt: 1 },
      studentAnswer: { not: null },
    },
    select: {
      questionNum: true, answer: true, studentAnswer: true,
      transcribedStem: true, marksAwarded: true, marksAvailable: true,
      markingNotes: true,
      examPaper: { select: { title: true, completedAt: true, assignedToId: true } },
    },
    orderBy: { examPaper: { completedAt: "desc" } },
    take: 80,
  });
  console.log(`\nMissed Comp Cloze questions (last 60d): ${qs.length}\n`);
  for (const q of qs) {
    const studentName = users.find(u => u.id === q.examPaper.assignedToId)?.name ?? "?";
    console.log(`--- ${studentName} | ${q.examPaper.title.slice(0, 35)} | Q${q.questionNum}`);
    console.log(`  Student wrote: "${q.studentAnswer}"`);
    console.log(`  Correct:       "${q.answer}"`);
    console.log(`  marks: ${q.marksAwarded ?? 0}/${q.marksAvailable ?? 1}`);
    if (q.markingNotes && q.markingNotes.length < 200) console.log(`  notes: ${q.markingNotes}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
