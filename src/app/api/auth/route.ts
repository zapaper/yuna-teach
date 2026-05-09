import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { setSession, clearSession } from "@/lib/session";

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

  // Set signed session cookie so privileged routes (admin) can trust the caller
  await setSession(user.id);

  // Stamp last-login for the manage-users panel. Best-effort — don't
  // block the response if the write fails for any reason.
  prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    .catch(() => { /* non-fatal */ });

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

// DELETE /api/auth — log out, clear session cookie.
// Sets the Set-Cookie header DIRECTLY on the response object instead
// of going through cookies().delete() / clearSession(). The latter
// path turned out unreliable across Next.js versions — sometimes the
// mutation didn't propagate to the response, leaving the cookie in
// the browser. Explicit response.cookies.set("", maxAge=0) always
// emits the right Set-Cookie header.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("yuna_session", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
  return res;
}
