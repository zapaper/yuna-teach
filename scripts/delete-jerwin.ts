import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmojrpu6k001e12cdxn30759m";
  const before = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!before) {
    console.log("User not found — nothing to delete.");
    return;
  }
  console.log(`Deleting: ${JSON.stringify(before)}`);
  const result = await prisma.user.delete({ where: { id } });
  console.log(`Deleted user id=${result.id} name=${result.name}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
