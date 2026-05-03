import { NextRequest, NextResponse } from "next/server";
import { isSessionAdmin } from "@/lib/session";
import { analyseStudentMistakes } from "@/lib/revision";

// GET /api/admin/student-revision/summary?studentId=<id>
//
// Returns per-subject mistake stats for a student across their last
// 100 completed papers. Powers the parent-dashboard "Revise work"
// modal's initial render.

export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const studentId = request.nextUrl.searchParams.get("studentId");
  if (!studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }
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
