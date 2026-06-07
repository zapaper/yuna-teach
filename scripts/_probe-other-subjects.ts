import { prisma } from "../src/lib/db";
function bucket(raw: string | null | undefined): string {
  const lower = (raw ?? "").toLowerCase();
  if (lower.includes("math")) return "Math";
  if (lower.includes("science") || lower.includes("sci")) return "Science";
  if (lower.includes("english") || lower.includes("eng")) return "English";
  if (lower.includes("chinese") || raw?.includes("华文") || raw?.includes("中文") || raw?.includes("华语")) return "Chinese";
  return "Other";
}
async function main() {
  const papers = await prisma.examPaper.findMany({
    where: { markingStatus: { in: ["complete", "released"] }, assignedToId: { not: null } },
    select: { subject: true, title: true, paperType: true },
  });
  const others = papers.filter(p => bucket(p.subject) === "Other");
  console.log(`Total marked papers: ${papers.length}, in "Other" bucket: ${others.length}`);
  // Group by exact subject string
  const byRaw = new Map<string, { count: number; sample: string }>();
  for (const p of others) {
    const key = `${p.subject ?? "(null)"} | type=${p.paperType ?? "(master)"}`;
    const e = byRaw.get(key) ?? { count: 0, sample: p.title };
    e.count++;
    byRaw.set(key, e);
  }
  for (const [k, v] of [...byRaw.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${v.count.toString().padStart(4)} × subject="${k}" sample title="${v.sample.slice(0, 60)}"`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
