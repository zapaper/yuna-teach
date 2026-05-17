import { prisma } from "../src/lib/db";

(async () => {
  const ID = "cmm5wf91d000ryrxwaddlo6xh";
  const u = await prisma.user.findUnique({ where: { id: ID }, select: { name: true, settings: true } });
  if (!u) { console.error("user not found"); process.exit(1); }
  console.log(`Before: ${u.name} settings=${JSON.stringify(u.settings)}`);

  const cur = (u.settings as Record<string, unknown>) ?? {};
  const purchasedRaw = Array.isArray(cur.purchasedPets) ? (cur.purchasedPets as unknown[]) : [];
  const purchased = new Set<string>(purchasedRaw.filter((x): x is string => typeof x === "string"));
  purchased.add("merlion");
  purchased.add("uni");

  const next = {
    ...cur,
    arenaBonusPoints: 300,
    purchasedPets: [...purchased],
    whitetigerCelebrate: true,
  };

  await prisma.user.update({ where: { id: ID }, data: { settings: next } });

  const after = await prisma.user.findUnique({ where: { id: ID }, select: { settings: true } });
  console.log(`After:  settings=${JSON.stringify(after?.settings)}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
