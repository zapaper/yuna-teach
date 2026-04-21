// Unlock Merlion + Otter (and everything below 1500 pts) for the exact-name
// student555 by setting settings.bonusPoints = 1500.
import { prisma } from "@/lib/db";

async function main() {
  const u = await prisma.user.findFirst({
    where: { name: "student555" },
    select: { id: true, name: true, settings: true },
  });
  if (!u) { console.log("student555 not found"); return; }
  const current = (u.settings ?? {}) as Record<string, unknown>;
  const next = { ...current, avatar: true, bonusPoints: 1750, bonusCrystals: 100 };
  await prisma.user.update({ where: { id: u.id }, data: { settings: next } });
  console.log(`Updated ${u.id} (${u.name}):`, next);
}

main().finally(() => prisma.$disconnect());
