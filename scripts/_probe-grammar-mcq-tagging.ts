// Probe: are Grammar MCQ master questions tagged with subTopic?
// If none/few are tagged, the diagnostic English quiz can't
// stratify by rule and the fluency table stays empty even after
// completion.

import { prisma } from "@/lib/db";

async function main() {
  const grammarMcqs = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        subject: { contains: "english", mode: "insensitive" },
        paperType: null,
        visible: true,
      },
      syllabusTopic: { contains: "grammar", mode: "insensitive" },
      NOT: [
        { syllabusTopic: { contains: "cloze", mode: "insensitive" } },
      ],
      sourceQuestionId: null,
    },
    select: { id: true, subTopic: true, examPaper: { select: { level: true } } },
  });
  const totalMasters = grammarMcqs.length;
  const tagged = grammarMcqs.filter(q => q.subTopic && q.subTopic.trim().length > 0).length;
  console.log(`Grammar MCQ masters: ${totalMasters}`);
  console.log(`Tagged (subTopic set): ${tagged}`);
  console.log(`Untagged: ${totalMasters - tagged}`);
  console.log(`\nBy subTopic:`);
  const bySt = new Map<string, number>();
  for (const q of grammarMcqs) {
    const k = q.subTopic ?? "(null)";
    bySt.set(k, (bySt.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...bySt.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}  '${k}'`);
  }

  const synthesis = await prisma.examQuestion.findMany({
    where: {
      examPaper: { subject: { contains: "english", mode: "insensitive" }, paperType: null, visible: true },
      syllabusTopic: { contains: "synthesis", mode: "insensitive" },
      sourceQuestionId: null,
    },
    select: { id: true, subTopic: true },
  });
  console.log(`\nSynthesis masters: ${synthesis.length}`);
  const synTagged = synthesis.filter(q => q.subTopic && q.subTopic.trim().length > 0).length;
  console.log(`Synthesis tagged: ${synTagged}`);
  const bySn = new Map<string, number>();
  for (const q of synthesis) {
    const k = q.subTopic ?? "(null)";
    bySn.set(k, (bySn.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...bySn.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}  '${k}'`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
