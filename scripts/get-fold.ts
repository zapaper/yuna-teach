import { prisma } from "../src/lib/db";
async function main() {
  const t = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmpjlj8un00dseplma0mky71q", questionNum: "13", syllabusTopic: { contains: "Geomet" } },
    select: { questionNum: true, marksAvailable: true, transcribedStem: true, answer: true, transcribedOptions: true },
  });
  console.log(`PSLE 2022 Q13 (${t?.marksAvailable}m)`);
  console.log(`STEM:\n${t?.transcribedStem}`);
  console.log(`\nOPTIONS: ${JSON.stringify(t?.transcribedOptions)}`);
  console.log(`\nANSWER:\n${t?.answer}`);

  // Also try 2025 Q14 — said to be a stronger equilateral example
  const t2025 = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmpjbfr0a0001hx5ot7bzhurl", questionNum: "14", syllabusTopic: { contains: "Geomet" } },
    select: { questionNum: true, marksAvailable: true, transcribedStem: true, answer: true, transcribedOptions: true },
  });
  console.log(`\n=== PSLE 2025 Q14 (${t2025?.marksAvailable}m) ===`);
  console.log(`STEM:\n${t2025?.transcribedStem}`);
  console.log(`OPTIONS: ${JSON.stringify(t2025?.transcribedOptions)}`);
  console.log(`ANSWER:\n${t2025?.answer}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
