// Look up a student by name and inspect how their level was recorded.

import { prisma } from "../src/lib/db";

const NAME_QUERY = process.argv[2] ?? "zane";

async function main() {
  const matches = await prisma.user.findMany({
    where: {
      name: { contains: NAME_QUERY, mode: "insensitive" },
      role: "STUDENT",
    },
    select: {
      id: true, name: true, role: true, level: true, createdAt: true,
      studentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  if (matches.length === 0) { console.log(`no STUDENT matching "${NAME_QUERY}"`); return; }
  for (const u of matches) {
    console.log(`\n${u.id}  ${u.name}  level=${u.level}  created=${u.createdAt.toISOString()}`);
    for (const link of u.studentLinks) {
      const p = link.parent;
      console.log(`  parent: ${p.name} <${p.email ?? "no-email"}> (${p.id})`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
