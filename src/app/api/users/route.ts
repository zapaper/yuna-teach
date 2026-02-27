import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      level: u.level,
      createdAt: u.createdAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, role, level } = body;

  if (!name || !role) {
    return NextResponse.json(
      { error: "Name and role are required" },
      { status: 400 }
    );
  }

  const user = await prisma.user.create({
    data: {
      name,
      role,
      level: role === "STUDENT" ? (level ?? 1) : null,
    },
  });

  return NextResponse.json(
    {
      id: user.id,
      name: user.name,
      role: user.role,
      level: user.level,
      createdAt: user.createdAt.toISOString(),
    },
    { status: 201 }
  );
}
