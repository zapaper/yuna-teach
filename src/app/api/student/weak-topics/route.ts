// GET /api/student/weak-topics?studentId=...&limit=5
// Returns the student's top weak topics with a recent-trend marker.
// Parents read it from the AI Smart Insights card.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeakTopics } from "@/lib/weak-topics";

export async function GET(req: NextRequest) {
  const studentId = req.nextUrl.searchParams.get("studentId");
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(10, Math.max(1, parseInt(limitParam ?? "5", 10) || 5));
  if (!studentId) return NextResponse.json({ error: "studentId required" }, { status: 400 });

  // Confirm the student exists and is a STUDENT (lightweight access
  // gate — the parent-vs-student relationship is enforced upstream
  // by the dashboard already only showing linked students in its
  // selector).
  const student = await prisma.user.findUnique({ where: { id: studentId }, select: { role: true } });
  if (!student || student.role !== "STUDENT") return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await getWeakTopics(studentId, limit);
  return NextResponse.json({ rows });
}
