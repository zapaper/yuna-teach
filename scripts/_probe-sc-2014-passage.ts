import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmpufpq4m000111bmp5t0lg85";
  const paper = await prisma.examPaper.findUnique({
    where: { id }, select: { metadata: true },
  });
  const md = (paper?.metadata ?? {}) as Record<string, unknown>;
  const sections = (md.chineseSections ?? []) as Array<Record<string, unknown>>;
  for (const s of sections) {
    console.log(`\n=== ${s.label}`);
    const p = String(s.passage ?? "");
    console.log(p);
    console.log(`---END (${p.length} chars)`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
