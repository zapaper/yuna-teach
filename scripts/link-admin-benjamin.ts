import { prisma } from "../src/lib/db";

const ADMIN_ID = "cmmfmehcz0000bbbfnwwiko75";
const STUDENT_ID = "cmopc9wpb007svj1mp4mgoae2";

(async () => {
  const a = await prisma.user.findUnique({ where: { id: ADMIN_ID }, select: { name: true, role: true } });
  const s = await prisma.user.findUnique({ where: { id: STUDENT_ID }, select: { name: true, role: true, level: true } });
  if (!a || a.role !== "PARENT") { console.error("admin not found / not PARENT", a); process.exit(1); }
  if (!s || s.role !== "STUDENT") { console.error("student not found / not STUDENT", s); process.exit(1); }
  console.log(`Admin: ${a.name}   Student: ${s.name} P${s.level}`);
  const existing = await prisma.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: ADMIN_ID, studentId: STUDENT_ID } },
    select: { id: true },
  });
  if (existing) {
    console.log("Already linked.");
  } else {
    await prisma.parentStudent.create({ data: { parentId: ADMIN_ID, studentId: STUDENT_ID } });
    console.log("LINKED.");
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
