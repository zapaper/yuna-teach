import { prisma } from "../src/lib/db";
async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      paperType: "diagnostic",
      markingStatus: { in: ["complete", "released"] },
      assignedToId: { not: null },
    },
    select: {
      id: true, title: true, subject: true, assignedToId: true,
      assignedTo: { select: { name: true } },
      questions: { select: { syllabusTopic: true, marksAvailable: true } },
    },
  });
  for (const p of papers) {
    const topics = new Map<string, number>();
    for (const q of p.questions) {
      const t = q.syllabusTopic ?? "Untagged";
      topics.set(t, (topics.get(t) ?? 0) + 1);
    }
    console.log(`${p.id} student=${p.assignedTo?.name ?? "—"} subject="${p.subject}" title="${p.title}"`);
    for (const [t, n] of [...topics.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n.toString().padStart(3)} × ${t}`);
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
