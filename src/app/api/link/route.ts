import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST — redeem an invite code to create a parent-student link
export async function POST(request: NextRequest) {
  const { code, userId } = await request.json();
  if (!code || !userId) {
    return NextResponse.json({ error: "code and userId required" }, { status: 400 });
  }

  // Normalise: trim whitespace (paste from chat apps often brings a leading
  // space or trailing newline), strip non-alphanumerics (some clients inject
  // zero-width or invisible chars), uppercase.
  const normalisedCode = String(code).trim().replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  // Find the invite code
  const invite = await prisma.inviteCode.findUnique({
    where: { code: normalisedCode },
    include: { user: true },
  });

  if (!invite) {
    return NextResponse.json({ error: "Invalid invite code" }, { status: 404 });
  }
  if (invite.expiresAt < new Date()) {
    return NextResponse.json({ error: "This code has expired. Ask for a fresh one." }, { status: 410 });
  }

  // Get the redeemer
  const redeemer = await prisma.user.findUnique({ where: { id: userId } });
  if (!redeemer) {
    return NextResponse.json({ error: "Your session is out of date. Please log in again." }, { status: 404 });
  }

  // Don't let a user redeem their own code.
  if (invite.userId === userId) {
    return NextResponse.json({ error: "You can't use your own code — share it with the other person." }, { status: 400 });
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
    // Both parents or both students — spell it out so the user knows why.
    const roleA = invite.user.role === "PARENT" ? "parent" : "student";
    const roleB = redeemer.role === "PARENT" ? "parent" : "student";
    return NextResponse.json(
      { error: `Can't link two ${roleA}s. One account must be parent, the other must be student.${roleA === roleB ? "" : ""}` },
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
