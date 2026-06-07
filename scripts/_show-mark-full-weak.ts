import { getWeakTopics } from "../src/lib/weak-topics";
import { prisma } from "../src/lib/db";

async function main() {
  const u = await prisma.user.findFirst({
    where: { name: { contains: "mark lim", mode: "insensitive" }, role: "STUDENT" },
    select: { id: true, name: true },
  });
  if (!u) return;
  const rows = await getWeakTopics(u.id, 40);
  console.log(`${u.name} — all ranked topics (limit 40)\n`);
  console.log("Subject".padEnd(11), "Topic".padEnd(38), "  N", "    Pct", "  Improving");
  console.log("-".repeat(80));
  for (const r of rows) {
    console.log(
      r.subject.padEnd(11),
      r.topic.slice(0, 36).padEnd(38),
      String(r.sample).padStart(4),
      `${r.pct.toFixed(1)}%`.padStart(7),
      "  ",
      r.improving ? "↑" : "",
    );
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
