import { prisma } from "../src/lib/db";

const STUDENT_ID = "cmnsa6bww006bgmuwflevt143"; // Student666 (admin-linked, P6)

(async () => {
  const before = await prisma.user.findUnique({
    where: { id: STUDENT_ID },
    select: { id: true, name: true, settings: true },
  });
  if (!before) {
    console.error("student not found");
    process.exit(1);
  }
  const settings = (before.settings as Record<string, unknown> | null) ?? {};
  const next = { ...settings, allowRevision: true };
  await prisma.user.update({
    where: { id: STUDENT_ID },
    data: { settings: next as import("@prisma/client").Prisma.InputJsonValue },
  });
  console.log(`Updated ${before.name} (${before.id})`);
  console.log("  before:", JSON.stringify(settings));
  console.log("  after :", JSON.stringify(next));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
