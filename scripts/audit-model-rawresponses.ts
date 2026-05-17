import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  // Find the most-recent successful extraction and dump its _debug metadata
  // so we can see which models actually carried each step.
  const papers = await prisma.examPaper.findMany({
    where: { extractionStatus: "ready" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, subject: true, title: true, metadata: true, createdAt: true },
  });
  for (const p of papers) {
    const meta = p.metadata as Record<string, unknown> | null;
    const dbg = (meta as { _debug?: Record<string, unknown> } | null)?._debug;
    console.log(`\n=== ${p.id}  ${p.title?.slice(0,40)}  (${p.subject}) ===`);
    if (!dbg) { console.log("  (no _debug metadata)"); continue; }
    // Look for keys that suggest model usage
    const keys = Object.keys(dbg);
    for (const k of keys) {
      if (k.toLowerCase().includes("model") || k.toLowerCase().includes("raw") || k.toLowerCase().includes("fallback")) {
        const v = (dbg as Record<string, unknown>)[k];
        const s = typeof v === "string" ? v.slice(0, 100) : JSON.stringify(v).slice(0, 150);
        console.log(`  ${k}: ${s}`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
