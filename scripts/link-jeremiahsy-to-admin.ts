// Link student "jeremiahsy" to the admin account so the admin can view
// their quizzes / focused tests from the parent dashboard. Idempotent —
// the unique index on (parentId, studentId) means re-runs are no-ops.
//
// Run: npx tsx scripts/link-jeremiahsy-to-admin.ts

import { prisma } from "@/lib/db";

async function main() {
  const admin = await prisma.user.findFirst({
    where: { name: { equals: "admin", mode: "insensitive" } },
    select: { id: true, name: true, email: true },
  });
  if (!admin) { console.log("No admin user found (user.name === 'admin')"); return; }

  const student = await prisma.user.findFirst({
    where: { name: { equals: "jeremiahsy", mode: "insensitive" }, role: "STUDENT" },
    select: { id: true, name: true, level: true },
  });
  if (!student) { console.log("Student 'jeremiahsy' not found"); return; }

  console.log(`admin:   ${admin.id}  ${admin.name}  ${admin.email ?? "—"}`);
  console.log(`student: ${student.id}  ${student.name}  P${student.level ?? "?"}`);

  const existing = await prisma.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: admin.id, studentId: student.id } },
  });
  if (existing) {
    console.log("Link already exists — nothing to do.");
    return;
  }

  await prisma.parentStudent.create({
    data: { parentId: admin.id, studentId: student.id },
  });
  console.log("Link created.");
}

main().finally(() => prisma.$disconnect());
