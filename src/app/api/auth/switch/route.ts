import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { setSession, getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";

// POST /api/auth/switch  { studentId }
//
// Swaps this browser's session cookie from parent → linked student
// (or, for admins, to any user). Used by the parent dashboard's
// "Open student's homepage" button — without this the new tab loads
// /home/{studentId} carrying the parent's cookie, which the auth
// guard rejects as unauthorised, dumping the user on /login.
//
// Authorization:
//   - Admin can swap to any user.
//   - Parent can swap only to a STUDENT they're linked to via
//     ParentStudent.
//
// All other browser tabs continue to send the new cookie too —
// there's no tab-scoped session in the web platform. Parent will
// need to log back in as themselves later.

export async function POST(req: NextRequest) {
  const callerId = await getSessionUserId();
  if (!callerId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { studentId?: string };
  const studentId = body.studentId;
  if (!studentId || typeof studentId !== "string") {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }

  const caller = await prisma.user.findUnique({
    where: { id: callerId },
    select: { id: true, name: true, settings: true, role: true },
  });
  if (!caller) return NextResponse.json({ error: "Caller not found" }, { status: 401 });

  const target = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, name: true, role: true },
  });
  if (!target) return NextResponse.json({ error: "Target user not found" }, { status: 404 });

  let allowed = isAdmin(caller);
  if (!allowed) {
    // Non-admin: must be a linked parent of a STUDENT target.
    if (caller.role !== "PARENT" || target.role !== "STUDENT") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: caller.id, studentId: target.id } },
      select: { id: true },
    });
    allowed = !!link;
  }
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  await setSession(target.id);
  return NextResponse.json({ ok: true, id: target.id, name: target.name });
}
