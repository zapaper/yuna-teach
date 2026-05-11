import { NextRequest, NextResponse } from "next/server";
import { analyseStudentMistakes } from "@/lib/revision";
import { requireAccessToStudent } from "@/lib/auth-guard";

// GET /api/admin/student-revision/summary?studentId=<id>
//
// Returns per-subject mistake stats for a student across their last
// 100 completed papers. Powers the parent-dashboard "Revise work"
// modal's initial render.
//
// Open to: admin, the student themselves, or any parent linked
// to the student via parent_students. (The path still says /admin/
// because the routes were originally admin-gated; left in place to
// avoid breaking the URL the modal already calls.)

export async function GET(request: NextRequest) {
  const studentId = request.nextUrl.searchParams.get("studentId");
  if (!studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }
  const auth = await requireAccessToStudent(studentId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const summary = await analyseStudentMistakes(studentId);
    return NextResponse.json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "summary failed";
    if (msg === "student not found") return NextResponse.json({ error: msg }, { status: 404 });
    console.error(`[student-revision/summary] ${studentId}:`, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
