import { prisma } from "../src/lib/db";

(async () => {
  const ID = "cmm5wf91d000ryrxwaddlo6xh";
  const ADD = 250;
  const u = await prisma.user.findUnique({ where: { id: ID }, select: { name: true, settings: true } });
  if (!u) { console.error("not found"); process.exit(1); }
  const cur = (u.settings as Record<string, unknown>) ?? {};
  const before = (cur.bonusPoints as number | undefined) ?? 0;
  const after = before + ADD;
  await prisma.user.update({
    where: { id: ID },
    data: { settings: { ...cur, bonusPoints: after } },
  });
  console.log(`${u.name}: bonusPoints ${before} -> ${after} (+${ADD})`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
