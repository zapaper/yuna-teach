// Subtract 300 from David Lim's arena bonus.

import { prisma } from "../src/lib/db";

const ID = "cmm5wf91d000ryrxwaddlo6xh";

async function main() {
  const u = await prisma.user.findUnique({ where: { id: ID }, select: { name: true, settings: true } });
  if (!u) { console.error("not found"); process.exit(1); }
  const settings = (u.settings as Record<string, unknown>) ?? {};
  const before = (settings.arenaBonusPoints as number | undefined) ?? 0;
  const after = before - 300;
  const next = { ...settings, arenaBonusPoints: after };
  await prisma.user.update({ where: { id: ID }, data: { settings: next } });
  console.log(`${u.name}: arenaBonusPoints ${before} → ${after}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
