import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const ID = process.argv[2] ?? "cmp8ipqma002bko6nu8sqn87u";
  const paper = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { id: true, title: true, subject: true, paperType: true, sourceExamId: true, assignedToId: true, metadata: true, completedAt: true },
  });
  if (!paper) return console.log("not found");
  console.log({
    id: paper.id, title: paper.title, subject: paper.subject,
    paperType: paper.paperType, sourceExamId: paper.sourceExamId,
    assignedToId: paper.assignedToId, completed: !!paper.completedAt,
  });
  const meta = paper.metadata as Record<string, unknown> | null;
  console.log("\nmetadata keys:", meta ? Object.keys(meta) : "(none)");
  const cs = (meta as { chineseSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> })?.chineseSections;
  if (cs) console.log("\nchineseSections:", cs.map(s => `${s.label}[${s.startIndex}-${s.endIndex}]${s.passage ? "+passage" : ""}`));
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID }, orderBy: { orderIndex: "asc" },
    select: { questionNum: true, syllabusTopic: true, pageIndex: true, orderIndex: true },
  });
  console.log(`\n${qs.length} questions:`);
  for (const q of qs) console.log(`  Q${q.questionNum.padEnd(6)} idx=${q.orderIndex} page=${q.pageIndex} [${q.syllabusTopic}]`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
