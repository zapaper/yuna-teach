// Probe: what topics ended up in a specific student's math diagnostic?
// The Lumi topic chart is only showing Geometry — we need to see if the
// quiz itself is single-topic, or if the quiz has diverse topics but
// only Geometry is being SURFACED by the progress pipeline.
//
// Run: npx tsx scripts/_probe-math-diagnostic-topics.ts

import { prisma } from "@/lib/db";

const STUDENT_ID = "cmr1zufy10003yyxj9e5afawo";

async function main() {
  const student = await prisma.user.findUnique({
    where: { id: STUDENT_ID },
    select: { id: true, name: true, displayName: true, level: true },
  });
  console.log("Student:", student);

  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: STUDENT_ID,
      subject: { contains: "math", mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, title: true, subject: true, paperType: true,
      markingStatus: true, createdAt: true, completedAt: true,
      metadata: true,
    },
  });
  console.log(`\nMath papers assigned to student: ${papers.length}`);
  for (const p of papers) {
    console.log(`\n  ${p.id}  ${p.title}  paperType=${p.paperType}  status=${p.markingStatus}`);
    console.log(`    createdAt=${p.createdAt.toISOString()} completedAt=${p.completedAt?.toISOString() ?? "-"}`);

    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { id: true, orderIndex: true, syllabusTopic: true, marksAwarded: true, marksAvailable: true },
      orderBy: { orderIndex: "asc" },
    });
    console.log(`    questions: ${qs.length}`);
    const topicCounts = new Map<string, number>();
    for (const q of qs) {
      const t = q.syllabusTopic ?? "(untagged)";
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
    console.log(`    topic breakdown:`);
    for (const [t, n] of [...topicCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${n}  ${t}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
