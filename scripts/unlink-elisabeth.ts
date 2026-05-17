import { prisma } from "../src/lib/db";
(async () => {
  const ADMIN_ID = "cmmfmehcz0000bbbfnwwiko75";
  const STUDENT_ID = "cmopmjzwo000x102oa1hkcoft"; // elisabethneo1
  const link = await prisma.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: ADMIN_ID, studentId: STUDENT_ID } },
  });
  if (!link) { console.log("Already unlinked."); await prisma.$disconnect(); return; }
  await prisma.parentStudent.delete({
    where: { parentId_studentId: { parentId: ADMIN_ID, studentId: STUDENT_ID } },
  });
  console.log("Unlinked admin → elisabethneo1");
  await prisma.$disconnect();
})();
