import { prisma } from "../src/lib/db";

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null, paperType: null,
      OR: [{ level: { equals: "PSLE", mode: "insensitive" } }, { title: { contains: "PSLE", mode: "insensitive" } }],
    },
    select: { id: true, title: true, subject: true, year: true, visible: true, questions: { select: { marksAvailable: true, syllabusTopic: true } } },
  });
  const math = papers.filter(p => (p.subject ?? "").toLowerCase().includes("math"));
  console.log("PSLE Math papers:", math.length);
  for (const p of math.sort((a, b) => String(a.year).localeCompare(String(b.year)))) {
    const totalM = p.questions.reduce((s, q) => s + (Number(q.marksAvailable) || 0), 0);
    console.log(`  ${String(p.year ?? "?").padEnd(11)}  visible:${String(p.visible).padEnd(5)}  Qs:${String(p.questions.length).padStart(3)}  Marks:${String(totalM).padStart(4)}  ${p.title}`);
  }
  console.log("\nUnique syllabusTopic values:");
  const topics = new Set<string>();
  for (const p of math) for (const q of p.questions) if (q.syllabusTopic) topics.add(q.syllabusTopic);
  for (const t of [...topics].sort()) console.log("  " + t);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
