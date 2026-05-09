// One-shot: existing users (signed up before the trial system existed)
// have null subscriptionStatus. Without backfilling, they'd be treated
// as trial-expired the moment the gate code deploys and immediately
// lose the ability to assign new work — bad UX.
//
// This script grants a 30-day grace window from now for every
// non-paying user, mirroring what new signups get. Paying users
// (subscriptionStatus="active" / "canceled" / "past_due" / "expired")
// are left alone — their subscription drives access, not the trial.
//
// Usage (from repo root):
//   npx tsx scripts/backfill-trial.ts
//
// Re-running is safe: only rows that still have null subscriptionStatus
// AND null trialEndsAt are touched.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const result = await prisma.user.updateMany({
    where: {
      subscriptionStatus: null,
      trialEndsAt: null,
    },
    data: {
      subscriptionStatus: "trialing",
      trialEndsAt,
    },
  });

  console.log(`Backfilled trialEndsAt for ${result.count} users.`);
  console.log(`Trial expires: ${trialEndsAt.toISOString()}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
