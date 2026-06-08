import { prisma } from "../src/lib/db";
import { isAdmin } from "../src/lib/admin";

(async () => {
  const userId = "cmmfmehcz0000bbbfnwwiko75";
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, displayName: true, email: true, settings: true, role: true },
  });
  console.log("User:", JSON.stringify(u, null, 2));
  console.log("isAdmin:", isAdmin(u));

  // Also check the eval clone paper
  const paperId = "cmq4ujtp10001awyq6bmh71zl";
  const p = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: {
      id: true, title: true, userId: true, assignedToId: true,
      paperType: true,
    },
  });
  console.log("\nPaper:", JSON.stringify(p, null, 2));

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
