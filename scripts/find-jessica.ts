import { prisma } from "../src/lib/db";

async function main() {
  const u = await prisma.user.findFirst({
    where: { email: { equals: "jessicabwt@gmail.com", mode: "insensitive" } },
    select: { id: true, name: true, displayName: true, email: true, role: true, settings: true, createdAt: true },
  });
  console.log(JSON.stringify(u, null, 2));
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
