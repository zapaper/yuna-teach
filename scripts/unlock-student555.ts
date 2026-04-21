// Apply admin overrides for student555: 2000 bonus points (unlocks all
// point-gated avatars & pets) + habitatOverride (unlocks crystal-gated pets
// and locked habitats).
//
// Run: npx tsx scripts/unlock-student555.ts

import { prisma } from "@/lib/db";

async function main() {
  // "student555" may be a display name, not an id — look it up either way.
  const identifier = "student555";
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { id: identifier },
        { name: identifier },
        { name: { contains: identifier, mode: "insensitive" } },
        { email: { contains: identifier, mode: "insensitive" } },
      ],
    },
    select: { id: true, settings: true, name: true, email: true },
  });
  if (!existing) {
    console.log("User not found:", identifier);
    return;
  }
  const userId = existing.id;
  const current = (existing.settings ?? {}) as Record<string, unknown>;
  const next = {
    ...current,
    avatar: true,
    habitats: true,
    habitatOverride: true,
    bonusPoints: 2000,
    whitetiger: true,
  };
  await prisma.user.update({ where: { id: userId }, data: { settings: next } });
  console.log(`Updated ${userId} (${existing.name} / ${existing.email ?? "no email"}):`, next);
}

main().finally(() => prisma.$disconnect());
