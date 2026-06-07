import { prisma } from "../src/lib/db";

async function main() {
  // Look up by email AND by name to be safe
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { equals: "melissawongis@gmail.com", mode: "insensitive" } },
        { name: { equals: "kidmummy", mode: "insensitive" } },
        { name: { contains: "melissa", mode: "insensitive" } },
        { email: { contains: "kidmummy", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, email: true },
  });
  console.log(JSON.stringify(users, null, 2));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
