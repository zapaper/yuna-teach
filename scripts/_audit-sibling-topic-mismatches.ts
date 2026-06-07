// Find multi-part question groups (same examPaperId + baseNum) where
// the siblings carry DIFFERENT syllabusTopic tags. Multi-part questions
// share a scenario by construction; siblings tagged differently is
// almost always a labeling mistake that splits the group during
// focused-practice sibling expansion.
import { prisma } from "../src/lib/db";

function baseNum(n: string) { return n.replace(/[a-zA-Z()]+$/, ""); }

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { not: null },
      examPaper: { sourceExamId: null, paperType: null, subject: { contains: "science", mode: "insensitive" } },
    },
    select: { id: true, questionNum: true, examPaperId: true, syllabusTopic: true, examPaper: { select: { title: true } } },
  });
  // Group by (paperId, baseNum). Skip groups of size 1.
  const groups = new Map<string, typeof qs>();
  for (const q of qs) {
    const k = `${q.examPaperId}::${baseNum(q.questionNum)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(q);
  }
  let conflicts = 0;
  for (const [k, group] of groups) {
    if (group.length < 2) continue;
    const topics = new Set(group.map(g => g.syllabusTopic ?? ""));
    if (topics.size <= 1) continue;
    conflicts++;
    const title = group[0].examPaper?.title ?? "?";
    console.log(`\n${title} — Q${baseNum(group[0].questionNum)} siblings have ${topics.size} different topics:`);
    for (const g of group) {
      console.log(`  Q${g.questionNum}: ${g.syllabusTopic}`);
    }
  }
  console.log(`\nTotal multi-part groups with mismatched topics: ${conflicts}`);
  process.exit(0);
}
main();
