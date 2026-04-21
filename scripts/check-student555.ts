// Read current settings for student555.
import { prisma } from "@/lib/db";

async function main() {
  const us = await prisma.user.findMany({
    where: { name: { contains: "student5", mode: "insensitive" } },
    select: { id: true, name: true, email: true, settings: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  for (const u of us) console.log(u);
}

main().finally(() => prisma.$disconnect());
