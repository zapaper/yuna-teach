import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  // Look at the last 30 papers and see what models were used.
  // fallbackModelUsed is set in metadata when a fallback fired.
  const papers = await prisma.examPaper.findMany({
    where: { extractionStatus: { in: ["ready", "failed"] } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, subject: true, title: true, extractionStatus: true, createdAt: true, metadata: true },
  });
  let totalReady = 0, totalFailed = 0, fallbackHits: Record<string, number> = {};
  for (const p of papers) {
    if (p.extractionStatus === "ready") totalReady++;
    else totalFailed++;
    const meta = p.metadata as Record<string, unknown> | null;
    const fb = (meta as { fallbackModelUsed?: string } | null)?.fallbackModelUsed;
    if (fb) fallbackHits[fb] = (fallbackHits[fb] ?? 0) + 1;
    console.log(`${p.createdAt.toISOString().slice(0,10)}  ${p.extractionStatus.padEnd(7)} ${(p.subject ?? "-").padEnd(10)} fb=${fb ?? "."}  ${p.title?.slice(0, 50)}`);
  }
  console.log("\n--- summary ---");
  console.log(`ready: ${totalReady}, failed: ${totalFailed}`);
  console.log(`fallback hits:`, fallbackHits);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
