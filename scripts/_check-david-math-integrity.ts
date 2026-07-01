import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const davidId = "cmm5wf91d000ryrxwaddlo6xh";
  const total = await prisma.examPaper.count({ where: { assignedToId: davidId } });
  const math = await prisma.examPaper.count({ where: { assignedToId: davidId, subject: { contains: "math", mode: "insensitive" } } });
  const mathComplete = await prisma.examPaper.count({ where: { assignedToId: davidId, subject: { contains: "math", mode: "insensitive" }, markingStatus: { in: ["complete", "released"] } } });
  console.log(`David: ${total} papers total  ·  ${math} Math  ·  ${mathComplete} Math complete`);

  // Also confirm student67 counts
  const s67 = await prisma.examPaper.count({ where: { assignedToId: "cmqg8upha0000l3ijfr3co6t8" } });
  console.log(`student67: ${s67} papers total (should be 3 diagnostics)`);
  await prisma.$disconnect();
})();
