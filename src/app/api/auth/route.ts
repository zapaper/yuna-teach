import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, email, password } = body;

  if (!password || (!name && !email)) {
    return NextResponse.json(
      { error: "Provide name or email, and password" },
      { status: 400 }
    );
  }

  // Try to find user by email first, then by name
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let where: any;
  if (email) {
    where = { email: { equals: email, mode: "insensitive" } };
  } else {
    where = { name: { equals: name, mode: "insensitive" } };
  }

  const includeLinks = {
    parentLinks: { include: { student: { select: { id: true, name: true } } } },
    studentLinks: { include: { parent: { select: { id: true, name: true } } } },
  };

  const user = await prisma.user.findFirst({ where, include: includeLinks });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 401 });
  }

  if (user.password !== password) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  return NextResponse.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    level: user.level,
    createdAt: user.createdAt.toISOString(),
    emailVerified: user.emailVerified,
    subscriptionStatus: user.subscriptionStatus || "free",
    linkedStudents: user.parentLinks.map((l) => l.student),
    linkedParents: user.studentLinks.map((l) => l.parent),
  });
}
