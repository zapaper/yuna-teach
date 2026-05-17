import { prisma } from "../src/lib/db";

const QUERY = process.argv[2];
if (!QUERY) { console.error("Usage: npx tsx scripts/enable-revision-by-name.ts <name-substring>"); process.exit(1); }

(async () => {
  const matches = await prisma.user.findMany({
    where: {
      role: "STUDENT",
      OR: [
        { name: { contains: QUERY, mode: "insensitive" } },
        { displayName: { contains: QUERY, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, level: true, settings: true },
  });
  if (matches.length === 0) {
    console.error(`No student matching "${QUERY}"`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.log(`Multiple matches — picking ALL of them:`);
    for (const m of matches) console.log(`  ${m.id}  ${m.name}  display=${m.displayName}  P${m.level}`);
  }
  for (const u of matches) {
    const settings = (u.settings as Record<string, unknown> | null) ?? {};
    const next = { ...settings, allowRevision: true };
    await prisma.user.update({
      where: { id: u.id },
      data: { settings: next as import("@prisma/client").Prisma.InputJsonValue },
    });
    console.log(`Updated ${u.name} (${u.id}, P${u.level})`);
    console.log(`  before: ${JSON.stringify(settings)}`);
    console.log(`  after : ${JSON.stringify(next)}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
