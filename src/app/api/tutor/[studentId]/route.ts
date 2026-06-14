import { NextRequest, NextResponse } from "next/server";
import { loadTutorData } from "@/lib/tutor";
import { requireAdmin } from "@/lib/auth-guard";

// Tutor data is admin-only for now while we workshop the UX. Will
// open to linked parents once the page is signed off.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const { studentId } = await params;
  const subject = request.nextUrl.searchParams.get("subject") ?? "Science";

  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const data = await loadTutorData(studentId, subject);
  return NextResponse.json(data);
}
