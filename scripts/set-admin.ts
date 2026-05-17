import { prisma } from "../src/lib/db";

// Usage: npx tsx scripts/set-admin.ts <email> <true|false>
async function main() {
  const email = process.argv[2];
  const flag = process.argv[3] === "true";
  if (!email) {
    console.error("Usage: tsx scripts/set-admin.ts <email> <true|false>");
    process.exit(1);
  }
  const before = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, name: true, email: true, settings: true },
  });
  if (!before) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  const merged = { ...((before.settings as Record<string, unknown>) ?? {}), admin: flag };
  await prisma.user.update({ where: { id: before.id }, data: { settings: merged } });
  console.log(`Set settings.admin=${flag} on ${before.name} <${before.email}>`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
