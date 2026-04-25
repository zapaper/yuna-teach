import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");

  // ?userId=<id> returns a single user under `user`. Callers that fetched
  // this endpoint without the param (and expected the full users list under
  // `users`) keep working since we only take this branch when the param is
  // present.
  if (userId) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        parentLinks: { include: { student: { select: { id: true, name: true, level: true, settings: true } } } },
        studentLinks: { include: { parent: { select: { id: true, name: true } } } },
      },
    });
    if (!u) return NextResponse.json({ user: null }, { status: 404 });
    return NextResponse.json({
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        level: u.level,
        settings: u.settings,
        createdAt: u.createdAt.toISOString(),
        linkedStudents: u.parentLinks.map((l) => ({ ...l.student, settings: l.student.settings as Record<string, boolean> | null })),
        linkedParents: u.studentLinks.map((l) => l.parent),
      },
    });
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      parentLinks: { include: { student: { select: { id: true, name: true, level: true, settings: true } } } },
      studentLinks: { include: { parent: { select: { id: true, name: true } } } },
    },
  });

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      level: u.level,
      settings: u.settings,
      createdAt: u.createdAt.toISOString(),
      linkedStudents: u.parentLinks.map((l) => ({ ...l.student, settings: l.student.settings as Record<string, boolean> | null })),
      linkedParents: u.studentLinks.map((l) => l.parent),
    })),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, role, level, email, password, parentId } = body;

  if (!name || !role || !password) {
    return NextResponse.json(
      { error: "Name, role, and password are required" },
      { status: 400 }
    );
  }

  // Students: name must be unique
  if (role === "STUDENT") {
    const existing = await prisma.user.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, role: "STUDENT" },
    });
    if (existing) {
      return NextResponse.json(
        { error: "This username is already taken" },
        { status: 409 }
      );
    }
  }

  // Parents: email required and must be unique
  if (role === "PARENT") {
    if (!email) {
      return NextResponse.json(
        { error: "Email is required for parent accounts" },
        { status: 400 }
      );
    }
    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "This email is already registered" },
        { status: 409 }
      );
    }
  }

  const user = await prisma.user.create({
    data: {
      name,
      role,
      password,
      email: role === "PARENT" ? email : null,
      level: role === "STUDENT" ? (level ?? 1) : null,
    },
  });

  // Auto-link student to parent if parentId provided
  if (role === "STUDENT" && parentId) {
    try {
      await prisma.parentStudent.create({
        data: { parentId, studentId: user.id },
      });
    } catch (err) {
      console.error("Failed to auto-link student to parent:", err);
    }
  }

  // Previously: we cloned every paper owned by the first-created parent
  // (the admin "Papa") to each new parent account on signup. That was
  // redundant — /api/exam already lets non-admin parents see admin's
  // visible master papers directly, no copy needed. The clone also made
  // each new parent appear as the creator of papers they didn't upload,
  // dragged along focused tests and random 'Math practice' uploads the
  // admin had, and ignored the student's level entirely. Removed.

  return NextResponse.json(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      level: user.level,
      createdAt: user.createdAt.toISOString(),
      linkedStudents: [],
      linkedParents: [],
    },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { userId, settings, name } = body as { userId?: string; settings?: Record<string, unknown>; name?: string };
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  if (!settings && typeof name !== "string") {
    return NextResponse.json({ error: "settings or name required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const data: import("@prisma/client").Prisma.UserUpdateInput = {};
  if (settings) {
    const merged = { ...((user.settings as Record<string, unknown>) ?? {}), ...settings };
    data.settings = merged as import("@prisma/client").Prisma.InputJsonValue;
  }
  if (typeof name === "string") {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 40) {
      return NextResponse.json({ error: "Name must be 2–40 characters" }, { status: 400 });
    }
    // Uniqueness check — case-insensitive, ignore self.
    const taken = await prisma.user.findFirst({
      where: { name: { equals: trimmed, mode: "insensitive" }, NOT: { id: userId } },
      select: { id: true },
    });
    if (taken) {
      return NextResponse.json({ error: "That name is already taken" }, { status: 409 });
    }
    data.name = trimmed;
  }

  await prisma.user.update({ where: { id: userId }, data });
  return NextResponse.json({ success: true, ...data });
}
