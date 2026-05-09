import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// Find MASTER (paperType=null, sourceExamId=null) questions whose
// `answer` field doesn't include every sub-part label that the
// question declares. The classic miss is shared-block answer keys
// — one Steps:... block solving (a) and (b) together, with the
// part labels appearing only on the "Final answer:" line.
//
// Cheap pre-filter at the DB level (transcribedSubparts is JSON;
// row-level "subparts non-empty" filter is the best we can do
// here), then narrow in JS by parsing the JSON and matching
// labels against the answer text.

const SOLVE_NOTE_PREFIX = "[solve on demand]";

function isMasterPaper(): Prisma.ExamPaperWhereInput {
  return {
    sourceExamId: null,
    paperType: null,
    NOT: [
      { examType: "Synthetic" },
      { title: { startsWith: "[Synthetic Bank]" } },
    ],
  };
}

type Subpart = { label: string; text: string };

// True if `answer` doesn't mention every non-internal sub-part
// label as "(a)", "(b)", etc. Internal labels ("_drawable",
// "_subref-a") are filtered out.
function hasGap(answer: string | null, subparts: unknown): boolean {
  const subs: Subpart[] = Array.isArray(subparts)
    ? (subparts as Subpart[]).filter(
        (s) => s && typeof s.label === "string" && !s.label.startsWith("_") && typeof s.text === "string",
      )
    : [];
  if (subs.length === 0) return false;
  const ans = (answer ?? "").toLowerCase();
  return subs.some((s) => !ans.includes(`(${s.label.toLowerCase()})`));
}

// GET — return up to 30 master questions whose answer has a gap.
// Optional ?excludeIds=id1,id2 lets the admin skip rows already
// reviewed in this session without persisting state.
export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const excludeRaw = request.nextUrl.searchParams.get("excludeIds");
  const excludeIds = excludeRaw ? excludeRaw.split(",").filter(Boolean) : [];

  // Pull a generous window of candidates (need to re-filter in JS
  // because the gap check requires JSON parsing). Limit by a
  // reasonable cap to keep memory bounded.
  const candidates = await prisma.examQuestion.findMany({
    where: {
      examPaper: isMasterPaper(),
      transcribedSubparts: { not: Prisma.AnyNull },
      ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedSubparts: true,
      answer: true,
      flagged: true,
      markingNotes: true,
      examPaper: { select: { id: true, title: true, level: true, subject: true } },
    },
    orderBy: { id: "asc" },
    take: 500,
  });

  const withGap = candidates.filter((q) => hasGap(q.answer, q.transcribedSubparts)).slice(0, 30);

  return NextResponse.json({
    items: withGap.map((q) => ({
      id: q.id,
      questionNum: q.questionNum,
      paperId: q.examPaper.id,
      paperTitle: q.examPaper.title,
      level: q.examPaper.level,
      subject: q.examPaper.subject,
      stem: q.transcribedStem ?? "",
      subparts: Array.isArray(q.transcribedSubparts) ? q.transcribedSubparts : null,
      answer: q.answer ?? "",
      flagged: q.flagged,
      alreadyMarked: (q.markingNotes ?? "").startsWith(SOLVE_NOTE_PREFIX),
    })),
    counted: withGap.length,
    scanned: candidates.length,
  });
}

// POST — { action: "mark-handled", id, newAnswer? } persist the
// admin's fix. If newAnswer is provided, write it. Either way clear
// the [solve on demand] flag (since it's now resolved).
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const { action, id, newAnswer } = body as {
    action?: string; id?: string; newAnswer?: string;
  };
  if (action !== "mark-handled" || !id) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const data: Prisma.ExamQuestionUpdateInput = {
    flagged: false,
    flaggedAt: null,
    markingNotes: null,
  };
  if (typeof newAnswer === "string" && newAnswer.trim()) {
    data.answer = newAnswer.trim();
  }
  await prisma.examQuestion.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}
