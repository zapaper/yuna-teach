import { prisma } from "../src/lib/db";
(async () => {
  const admin = await prisma.user.findFirst({
    where: { name: { equals: "admin", mode: "insensitive" } },
    select: {
      id: true, name: true,
      parentLinks: { select: { studentId: true, student: { select: { id: true, name: true, level: true, settings: true } } } },
    },
  });
  console.log("admin:", admin?.id, admin?.name);
  console.log("links:", admin?.parentLinks.length);
  for (const l of admin?.parentLinks ?? []) {
    if (l.student.name.toLowerCase().includes("student666")) {
      console.log(">>>", l.student.id, l.student.name, "P" + l.student.level, "settings:", JSON.stringify(l.student.settings));
    }
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
