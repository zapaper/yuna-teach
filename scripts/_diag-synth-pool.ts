import { prisma } from "../src/lib/db";

async function main() {
  const TOPICS = ["Synthesis / Transformation", "Synthesis & Transformation"];
  const all = await prisma.examQuestion.count({
    where: { syllabusTopic: { in: TOPICS }, marksAwarded: { not: null } },
  });
  const visible = await prisma.examQuestion.count({
    where: { syllabusTopic: { in: TOPICS }, marksAwarded: { not: null }, examPaper: { visible: true } },
  });
  console.log({ marked_engsynth_anywhere: all, marked_engsynth_visible: visible });

  // What papers have marked English synthesis questions?
  const papers = await prisma.examQuestion.findMany({
    where: { syllabusTopic: { in: TOPICS }, marksAwarded: { not: null } },
    select: { examPaper: { select: { title: true, paperType: true, visible: true } } },
    take: 10,
  });
  console.log("\nFirst 10 papers with marked synthesis questions:");
  for (const p of papers) console.log(` visible=${p.examPaper.visible} type=${p.examPaper.paperType}  ${p.examPaper.title.slice(0, 80)}`);

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
