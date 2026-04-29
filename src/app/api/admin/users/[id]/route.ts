import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";

// DELETE /api/admin/users/[id]
//
// Cascades through ParentStudent (FK is onDelete: Cascade), examPapers
// owned by the user, etc. — see prisma/schema.prisma for the exact
// cascade behavior. Admin only; admins also can't delete themselves.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const sessionId = await getSessionUserId();
  if (sessionId === id) {
    return NextResponse.json({ error: "Cannot delete the currently logged-in admin" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await prisma.user.delete({ where: { id } });
  console.log(`[admin] deleted user id=${id} name=${target.name} role=${target.role}`);
  return NextResponse.json({ ok: true });
}
