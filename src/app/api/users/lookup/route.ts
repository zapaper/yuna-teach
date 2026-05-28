import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Returns the username for a given userId. Used by the login page to
// pre-fill the identity field when redirected from /home/<userId>.
//
// Privacy note: equivalent exposure to /api/users/check?name= — that
// endpoint leaks name → exists; this one leaks userId → name. The
// userId is already in the URL the caller arrived from (via `next=`),
// so this doesn't widen the threat surface. Returns { name: null }
// rather than 404 so the caller can always fall through to "leave
// the field empty" without special-casing the error path.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id || typeof id !== "string") return NextResponse.json({ name: null });
  const user = await prisma.user.findUnique({
    where: { id },
    select: { name: true },
  });
  return NextResponse.json({ name: user?.name ?? null });
}
