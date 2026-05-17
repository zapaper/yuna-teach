import { prisma } from "../src/lib/db";
const QUERY = process.argv[2];
const PROMOTE = process.argv[3] === "--promote";
if (!QUERY) { console.error("Usage: npx tsx scripts/find-and-promote.ts <name-or-email> [--promote]"); process.exit(1); }

(async () => {
  const matches = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: QUERY, mode: "insensitive" } },
        { displayName: { contains: QUERY, mode: "insensitive" } },
        { email: { contains: QUERY, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, displayName: true, email: true, role: true, settings: true },
  });
  for (const u of matches) {
    console.log(`${u.id}  ${u.role}  ${u.name}  display=${u.displayName}  email=${u.email}`);
    console.log(`  settings: ${JSON.stringify(u.settings)}`);
  }
  if (PROMOTE) {
    if (matches.length !== 1) {
      console.error("\nRefusing to promote — query must match exactly one user");
      process.exit(1);
    }
    const u = matches[0];
    if (u.role !== "PARENT") {
      console.error("\nRefusing to promote — user is not a PARENT");
      process.exit(1);
    }
    const next = { ...((u.settings as Record<string, unknown> | null) ?? {}), admin: true };
    await prisma.user.update({ where: { id: u.id }, data: { settings: next as import("@prisma/client").Prisma.InputJsonValue } });
    console.log(`\nPromoted ${u.name} to admin (settings.admin = true).`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
