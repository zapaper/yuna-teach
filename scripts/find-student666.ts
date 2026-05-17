import { prisma } from "../src/lib/db";
(async () => {
  const matches = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: "student666", mode: "insensitive" } },
        { displayName: { contains: "student666", mode: "insensitive" } },
      ],
    },
    select: {
      id: true, name: true, displayName: true, role: true, level: true, settings: true,
      parentLinks: { select: { parentId: true, parent: { select: { name: true } } } },
    },
  });
  console.log(`Found ${matches.length}`);
  for (const u of matches) {
    console.log(`${u.id}  name=${u.name}  display=${u.displayName}  role=${u.role}  level=P${u.level}`);
    console.log("  settings:", JSON.stringify(u.settings));
    console.log("  parents:", u.parentLinks.map((l) => `${l.parent.name}(${l.parentId})`).join(", ") || "(none)");
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
