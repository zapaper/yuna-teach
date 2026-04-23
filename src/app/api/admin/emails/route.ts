import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// Admin-only: return every user email (non-null) for the beta mailing list.
// Also returns name + createdAt for context so you can sort or filter before
// exporting to your mail tool.
export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const users = await prisma.user.findMany({
    where: { email: { not: null } },
    select: { id: true, name: true, email: true, role: true, createdAt: true, emailVerified: true },
    orderBy: { createdAt: "desc" },
  });
  const emails = users.map(u => u.email!).filter(Boolean);
  return NextResponse.json({ total: users.length, uniqueEmails: [...new Set(emails)].length, users });
}
