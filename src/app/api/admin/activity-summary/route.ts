// GET /api/admin/activity-summary
//
// Lightweight read-only API for the markforyou-mailer programme.
// Returns the number of completed papers (quizzes / focused practice /
// assigned tests) by a single student OR by all children of a single
// parent, over the last N days (default 7).
//
// Auth: same Bearer NURTURE_API_TOKEN as /api/admin/parent-progress.
//
// Query params (one of {studentId, parentId} is REQUIRED):
//   studentId={cuid}       — count papers assigned to this student.
//   parentId={cuid}        — count papers across every linked child.
//   days={int}=7           — lookback window (1..90).
//   bySubject={true|false}=true — include the per-subject breakdown
//                            in the response.
//
// Response shape:
//   {
//     mode: "student" | "parent",
//     id: "<the id you passed in>",
//     windowDays: 7,
//     since: "2026-06-18T00:00:00.000Z",
//     until: "2026-06-25T00:00:00.000Z",
//     students: [
//       {
//         id: "<student id>",
//         name: "Mark",
//         totalPapers: 23,
//         papers: { quiz: 14, focused: 6, assigned: 3 },
//         marks: { awarded: 318, available: 420, percent: 75.7 },
//         bySubject: [
//           { subject: "English", papers: 12, marks: { awarded: 180, available: 220, percent: 81.8 } },
//           { subject: "Math",    papers: 6,  marks: { awarded: 84,  available: 130, percent: 64.6 } },
//           ...
//         ]
//       },
//       ...
//     ],
//     // For convenience when mode=parent: sum across all linked children.
//     totals: { totalPapers, papers, marks, bySubject }
//   }
//
// Notes:
// - "Completed paper" = ExamPaper.completedAt is non-null AND the
//   paper was assigned (assignedToId set) — not master / synthetic /
//   admin-cloned-but-never-attempted rows.
// - Subject string is normalised (Math/Science/English/Chinese) for
//   the breakdown; raw values stay in the ExamPaper rows.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

type Bucket = "quiz" | "focused" | "assigned";

type PerSubject = {
  subject: string;
  papers: number;
  marks: { awarded: number; available: number; percent: number };
};

type PerStudent = {
  id: string;
  name: string;
  totalPapers: number;
  papers: { quiz: number; focused: number; assigned: number };
  marks: { awarded: number; available: number; percent: number };
  bySubject: PerSubject[];
};

function normaliseSubject(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith("math")) return "Math";
  if (lower.startsWith("sci")) return "Science";
  if (lower.includes("chinese") || lower.includes("华文")) return "Chinese";
  if (lower.startsWith("english")) return "English";
  return raw;
}

function bucketFor(p: { paperType: string | null; sourceExamId: string | null }): Bucket {
  if (p.paperType === "focused" || p.paperType === "mastery") return "focused";
  if (p.paperType === "quiz") return "quiz";
  // Cloned exam papers (sourceExamId set, paperType null) = parent-assigned
  // full papers ("Set as homework") — count as assigned.
  if (p.sourceExamId) return "assigned";
  return "assigned";
}

function pct(awarded: number, available: number): number {
  if (available <= 0) return 0;
  return Math.round((awarded / available) * 1000) / 10;
}

export async function GET(request: NextRequest) {
  // Auth — same Bearer token as the existing parent-progress route.
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const expected = process.env.NURTURE_API_TOKEN ?? "";
  if (!expected || bearer !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const studentId = request.nextUrl.searchParams.get("studentId")?.trim() || null;
  const parentId  = request.nextUrl.searchParams.get("parentId")?.trim()  || null;
  const daysRaw   = parseInt(request.nextUrl.searchParams.get("days") ?? "7", 10);
  const days      = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 7;
  const bySubject = request.nextUrl.searchParams.get("bySubject") !== "false";

  if (!studentId && !parentId) {
    return NextResponse.json({ error: "studentId or parentId is required" }, { status: 400 });
  }

  // Resolve the list of student ids we need to sum over.
  let studentIds: string[] = [];
  let mode: "student" | "parent";
  if (studentId) {
    mode = "student";
    studentIds = [studentId];
  } else {
    mode = "parent";
    // ParentStudent join table — see /api/admin/parent-progress for the
    // same pattern. We accept the parent's User.id and look up the kids.
    const links = await prisma.parentStudent.findMany({
      where: { parentId: parentId! },
      select: { studentId: true },
    });
    studentIds = links.map(l => l.studentId);
  }

  if (studentIds.length === 0) {
    return NextResponse.json({
      mode,
      id: studentId ?? parentId,
      windowDays: days,
      since: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      until: new Date().toISOString(),
      students: [],
      totals: { totalPapers: 0, papers: { quiz: 0, focused: 0, assigned: 0 }, marks: { awarded: 0, available: 0, percent: 0 }, bySubject: [] },
    });
  }

  // Pull student names so the response is self-explanatory.
  const studentRows = await prisma.user.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, name: true, displayName: true },
  });
  const nameById = new Map(studentRows.map(s => [s.id, s.displayName ?? s.name ?? "(unnamed)"] as const));

  // Window.
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const until = new Date();

  // Pull every completed paper assigned to one of these students in
  // the window. We select only the fields we need to bucket + sum.
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: studentIds },
      completedAt: { gte: since, lte: until },
    },
    select: {
      assignedToId: true,
      subject: true,
      paperType: true,
      sourceExamId: true,
      score: true,
      totalMarks: true,
    },
  });

  // Aggregate per-student.
  const perStudent = new Map<string, PerStudent>();
  for (const sid of studentIds) {
    perStudent.set(sid, {
      id: sid,
      name: nameById.get(sid) ?? "(unknown)",
      totalPapers: 0,
      papers: { quiz: 0, focused: 0, assigned: 0 },
      marks: { awarded: 0, available: 0, percent: 0 },
      bySubject: [],
    });
  }
  // Subject sub-aggregation kept in a Map per student id.
  const subjBuckets = new Map<string, Map<string, { papers: number; awarded: number; available: number }>>();
  for (const sid of studentIds) subjBuckets.set(sid, new Map());

  for (const p of papers) {
    if (!p.assignedToId) continue;
    const slot = perStudent.get(p.assignedToId);
    if (!slot) continue;
    slot.totalPapers++;
    slot.papers[bucketFor({ paperType: p.paperType, sourceExamId: p.sourceExamId })]++;
    // ExamPaper.totalMarks is a String? in the schema (legacy decision —
    // some papers print "30m", "30 marks", etc. instead of a raw int).
    // Coerce to a number for the breakdown; drop anything that doesn't
    // parse to a real number.
    const tmRaw = p.totalMarks;
    const tm = tmRaw == null ? 0 : (parseFloat(String(tmRaw)) || 0);
    slot.marks.awarded += p.score ?? 0;
    slot.marks.available += tm;
    if (bySubject) {
      const subj = normaliseSubject(p.subject);
      const map = subjBuckets.get(p.assignedToId)!;
      const entry = map.get(subj) ?? { papers: 0, awarded: 0, available: 0 };
      entry.papers++;
      entry.awarded += p.score ?? 0;
      entry.available += tm;
      map.set(subj, entry);
    }
  }

  // Finalise per-student percents + flatten subject buckets.
  const students: PerStudent[] = [];
  for (const sid of studentIds) {
    const slot = perStudent.get(sid)!;
    slot.marks.percent = pct(slot.marks.awarded, slot.marks.available);
    if (bySubject) {
      const map = subjBuckets.get(sid)!;
      slot.bySubject = [...map.entries()]
        .map(([subject, e]) => ({
          subject,
          papers: e.papers,
          marks: { awarded: e.awarded, available: e.available, percent: pct(e.awarded, e.available) },
        }))
        .sort((a, b) => b.papers - a.papers);
    }
    students.push(slot);
  }

  // Cross-student totals — handy for the parent-mode default email body.
  const totals = {
    totalPapers: students.reduce((s, x) => s + x.totalPapers, 0),
    papers: students.reduce((acc, x) => ({
      quiz: acc.quiz + x.papers.quiz,
      focused: acc.focused + x.papers.focused,
      assigned: acc.assigned + x.papers.assigned,
    }), { quiz: 0, focused: 0, assigned: 0 }),
    marks: {
      awarded: students.reduce((s, x) => s + x.marks.awarded, 0),
      available: students.reduce((s, x) => s + x.marks.available, 0),
      percent: 0,
    },
    bySubject: [] as PerSubject[],
  };
  totals.marks.percent = pct(totals.marks.awarded, totals.marks.available);

  if (bySubject) {
    const cross = new Map<string, { papers: number; awarded: number; available: number }>();
    for (const s of students) for (const sub of s.bySubject) {
      const e = cross.get(sub.subject) ?? { papers: 0, awarded: 0, available: 0 };
      e.papers += sub.papers;
      e.awarded += sub.marks.awarded;
      e.available += sub.marks.available;
      cross.set(sub.subject, e);
    }
    totals.bySubject = [...cross.entries()]
      .map(([subject, e]) => ({ subject, papers: e.papers, marks: { awarded: e.awarded, available: e.available, percent: pct(e.awarded, e.available) } }))
      .sort((a, b) => b.papers - a.papers);
  }

  return NextResponse.json({
    mode,
    id: studentId ?? parentId,
    windowDays: days,
    since: since.toISOString(),
    until: until.toISOString(),
    students,
    totals,
  });
}
