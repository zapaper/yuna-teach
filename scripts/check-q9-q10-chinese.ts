import { prisma } from "../src/lib/db";
const PAPERS = ["cmphqli6g002b98jke0olegzj", "cmphn6npc000112g1sdstau5j"]; // 2016 + 2025
async function main() {
  for (const id of PAPERS) {
    const paper = await prisma.examPaper.findUnique({ where: { id }, select: { title: true } });
    console.log(`\n=== ${paper?.title} ===`);
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id, questionNum: { in: ["9", "10", "11", "12", "13", "14", "15"] } },
      select: { questionNum: true, marksAvailable: true, syllabusTopic: true, transcribedStem: true, transcribedOptions: true },
      orderBy: { orderIndex: "asc" },
    });
    for (const q of qs) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 100);
      const opts = (q.transcribedOptions as string[] | null)?.join(" / ").slice(0, 80) ?? "";
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m, topic=${q.syllabusTopic}): ${stem}\n    opts: ${opts}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
