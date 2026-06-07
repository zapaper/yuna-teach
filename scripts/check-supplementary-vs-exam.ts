import { prisma } from "../src/lib/db";

async function main() {
  // What the 4,730 count covers: ExamPaper rows (sourceExamId IS NULL,
  // paperType IS NULL) and their ExamQuestion children. PSLE Paper 2
  // (Math / English / Chinese drillable MCQ + OEQ) lives here.
  const examMasterPsle = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null, paperType: null,
      title: { contains: "PSLE", mode: "insensitive" },
    },
    select: { subject: true, year: true, title: true, _count: { select: { questions: true } } },
    orderBy: [{ subject: "asc" }, { year: "asc" }],
  });
  console.log(`PSLE rows in ExamPaper (master, in the 4,730 count):  ${examMasterPsle.length}`);
  for (const p of examMasterPsle) {
    console.log(`  [${p.subject}] ${p.year}  ${p.title}  — ${p._count.questions} qs`);
  }

  // Separate table — English Oral/Compo supplementary, NOT in the 4,730
  // (no drillable questions, just composition/oral/listening source data)
  const eng = await prisma.englishSupplementaryPaper.findMany({
    select: { year: true, status: true },
    orderBy: { year: "asc" },
  });
  console.log(`\nEnglishSupplementaryPaper rows (NOT in 4,730):  ${eng.length}`);
  for (const p of eng) console.log(`  ${p.year}  status=${p.status}`);

  // Separate table — Chinese Oral/Compo supplementary, also NOT in 4,730
  const cn = await prisma.chineseSupplementaryPaper.findMany({
    select: { year: true, status: true },
    orderBy: { year: "asc" },
  });
  console.log(`\nChineseSupplementaryPaper rows (NOT in 4,730):  ${cn.length}`);
  for (const p of cn) console.log(`  ${p.year}  status=${p.status}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
