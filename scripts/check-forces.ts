import { prisma } from "../src/lib/db";
async function main() {
  // Check saved scripts
  const row = await prisma.masterClass.findUnique({ where: { slug: "forces" }, select: { keyConceptScripts: true } });
  const s = (row?.keyConceptScripts ?? []) as unknown as string[];
  console.log(`forces: ${s.length} saved scripts`);
  if (s.length > 0) {
    s.forEach((v, i) => console.log(`  slide ${i}: ${(v ?? "").length} chars · ${(v ?? "").slice(0, 70)}…`));
  }
  console.log();

  // Pull answer keys for cited PSLE questions
  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null, NOT: { title: { startsWith: "Test Quiz" } }, title: { contains: "PSLE", mode: "insensitive" }, subject: { contains: "science", mode: "insensitive" }, year: { in: ["2018", "2019", "2020", "2021"] } },
    select: { id: true, year: true, title: true },
  });
  const byYear = new Map(papers.map(p => [p.year ?? "", p.id]));
  console.log("Science papers:", [...byYear.entries()]);
  console.log();

  const targets = [
    { tag: "Pattern A", year: "2021", q: "20" },
    { tag: "Pattern B", year: "2018", q: "37" },
    { tag: "Pattern C", year: "2021", q: "40" },
    { tag: "Pattern D", year: "2019", q: "38" },
  ];
  for (const t of targets) {
    const id = byYear.get(t.year);
    if (!id) { console.log(`${t.tag}: no paper for ${t.year}`); continue; }
    const candidates = await prisma.examQuestion.findMany({
      where: { examPaperId: id, questionNum: t.q },
      select: { questionNum: true, marksAvailable: true, syllabusTopic: true, transcribedStem: true, answer: true, diagramImageData: true, imageData: true },
    });
    if (candidates.length === 0) { console.log(`${t.tag} (${t.year} Q${t.q}): no match`); continue; }
    const pick = candidates[0];
    console.log(`=== ${t.tag} — PSLE ${t.year} Q${pick.questionNum} (${pick.marksAvailable}m, ${pick.syllabusTopic}) ===`);
    console.log(`STEM: ${pick.transcribedStem?.slice(0, 400)}`);
    console.log(`ANSWER: ${pick.answer?.slice(0, 600)}`);
    console.log(`diagramImageData: ${pick.diagramImageData ? "YES" : "NO"}`);
    console.log();
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
