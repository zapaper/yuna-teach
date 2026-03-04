import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST — redeem an invite code to create a parent-student link
export async function POST(request: NextRequest) {
  const { code, userId } = await request.json();
  if (!code || !userId) {
    return NextResponse.json({ error: "code and userId required" }, { status: 400 });
  }

  // Find the invite code
  const invite = await prisma.inviteCode.findUnique({
    where: { code: code.toUpperCase() },
    include: { user: true },
  });

  if (!invite) {
    return NextResponse.json({ error: "Invalid invite code" }, { status: 404 });
  }
  if (invite.expiresAt < new Date()) {
    return NextResponse.json({ error: "Invite code has expired" }, { status: 410 });
  }

  // Get the redeemer
  const redeemer = await prisma.user.findUnique({ where: { id: userId } });
  if (!redeemer) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Determine parent and student
  let parentId: string;
  let studentId: string;

  if (invite.user.role === "PARENT" && redeemer.role === "STUDENT") {
    parentId = invite.userId;
    studentId = userId;
  } else if (invite.user.role === "STUDENT" && redeemer.role === "PARENT") {
    parentId = userId;
    studentId = invite.userId;
  } else {
    return NextResponse.json(
      { error: "Link requires one parent and one student" },
      { status: 400 }
    );
  }

  // Create the link (upsert to avoid duplicates)
  await prisma.parentStudent.upsert({
    where: { parentId_studentId: { parentId, studentId } },
    create: { parentId, studentId },
    update: {},
  });

  // Delete the used code
  await prisma.inviteCode.delete({ where: { id: invite.id } });

  // Return the linked user info
  const linkedUser = invite.userId === userId ? redeemer : invite.user;
  return NextResponse.json({
    linkedUser: { id: linkedUser.id, name: linkedUser.name, role: linkedUser.role },
  });
}

// GET — get linked users for a user
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (user.role === "PARENT") {
    const links = await prisma.parentStudent.findMany({
      where: { parentId: userId },
      include: { student: { select: { id: true, name: true, level: true } } },
    });
    return NextResponse.json({
      linkedStudents: links.map((l) => l.student),
      linkedParents: [],
    });
  } else {
    const links = await prisma.parentStudent.findMany({
      where: { studentId: userId },
      include: { parent: { select: { id: true, name: true } } },
    });
    return NextResponse.json({
      linkedStudents: [],
      linkedParents: links.map((l) => l.parent),
    });
  }
}

// DELETE — unlink a parent-student connection
export async function DELETE(request: NextRequest) {
  const parentId = request.nextUrl.searchParams.get("parentId");
  const studentId = request.nextUrl.searchParams.get("studentId");
  if (!parentId || !studentId) {
    return NextResponse.json({ error: "parentId and studentId required" }, { status: 400 });
  }

  await prisma.parentStudent.deleteMany({ where: { parentId, studentId } });
  return NextResponse.json({ ok: true });
}
