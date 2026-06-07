import { prisma } from "../src/lib/db";

async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmpjbfr0a0001hx5ot7bzhurl", questionNum: "P2-13" },
    select: { id: true, questionNum: true, diagramImageData: true, imageData: true },
  });
  if (!q) { console.log("not found"); return; }
  console.log(`Q${q.questionNum} (${q.id})`);
  console.log(`  diagramImageData: ${q.diagramImageData ? `${q.diagramImageData.length} chars, first 80: "${q.diagramImageData.slice(0, 80)}..."` : "null"}`);
  console.log(`  imageData: ${q.imageData ? `${q.imageData.length} chars, first 80: "${q.imageData.slice(0, 80)}..."` : "null"}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
