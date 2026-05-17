import { prisma } from "../src/lib/db";
(async () => {
  const link = await prisma.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: "cmmfmehcz0000bbbfnwwiko75", studentId: "cmonttxlx00678eodvb3mhovt" } },
  });
  if (!link) { console.log("Already unlinked."); await prisma.$disconnect(); return; }
  await prisma.parentStudent.delete({
    where: { parentId_studentId: { parentId: "cmmfmehcz0000bbbfnwwiko75", studentId: "cmonttxlx00678eodvb3mhovt" } },
  });
  console.log("Unlinked admin → EBSR2015");
  await prisma.$disconnect();
})();
