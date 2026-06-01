// Preview the weak-topics table for selected students by calling the
// library helper directly. This is what the AI Smart Insights card
// renders, so the output below is byte-for-byte what parents will see
// (modulo sort tie-breaking).

import { prisma } from "../src/lib/db";
import { getWeakTopics } from "../src/lib/weak-topics";

const STUDENTS = process.argv.slice(2);
if (STUDENTS.length === 0) STUDENTS.push("Mark lim", "David lim");

async function main() {
  for (const name of STUDENTS) {
    const u = await prisma.user.findFirst({
      where: { name: { contains: name, mode: "insensitive" }, role: "STUDENT" },
      select: { id: true, name: true },
    });
    if (!u) { console.log(`(no student matching "${name}")\n`); continue; }
    const rows = await getWeakTopics(u.id, 5);
    console.log(`========================================`);
    console.log(`${u.name}  — top 5 weak topics`);
    console.log(`========================================`);
    console.log("Subject     Topic                                Score   N    Improving");
    console.log("-".repeat(80));
    for (const r of rows) {
      const arrow = r.improving ? " ↑" : "";
      console.log(
        r.subject.padEnd(11),
        r.topic.slice(0, 36).padEnd(38),
        `${r.pct.toFixed(1)}%`.padStart(6),
        r.sample.toString().padStart(4),
        arrow,
      );
    }
    console.log();
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
