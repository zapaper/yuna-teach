import { NextRequest, NextResponse } from "next/server";
import { loadTutorData } from "@/lib/tutor";
import { requireAccessToStudent } from "@/lib/auth-guard";

// Tutor data is now open to anyone with access to the student
// (the kid, a linked parent, or an admin) — the Progress / Lumi
// view ships to all parents, not just admins.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const { studentId } = await params;
  const subject = request.nextUrl.searchParams.get("subject") ?? "Science";

  const auth = await requireAccessToStudent(studentId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const data = await loadTutorData(studentId, subject);
  return NextResponse.json(data);
}
