import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { normaliseAnswerKeyFormat } from "@/lib/answer-key-format";

// GET /api/admin/answer-key-format
//   Scan all math/science OEQ answer keys and return rows where the
//   normaliser would change the answer string. Read-only — no DB writes.
//
// POST /api/admin/answer-key-format
//   Body: { ids: string[] }  ← exam question ids to apply normalisation to
//   Writes the normalised answer to the DB for each id.

type Row = {
  id: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  level: number | null;
  subject: string | null;
  before: string;
  after: string;
};

export async function GET(_req: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const candidates = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        OR: [
          { subject: { contains: "math", mode: "insensitive" } },
          { subject: { contains: "science", mode: "insensitive" } },
        ],
        NOT: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
      answer: { not: null },
    },
    select: {
      id: true,
      questionNum: true,
      answer: true,
      examPaper: { select: { id: true, title: true, level: true, subject: true } },
    },
    orderBy: { id: "asc" },
    take: 2000,
  });

  const rows: Row[] = [];
  for (const q of candidates) {
    if (!q.answer) continue;
    const { normalized, changed } = normaliseAnswerKeyFormat(q.answer);
    if (!changed) continue;
    rows.push({
      id: q.id,
      questionNum: q.questionNum,
      paperId: q.examPaper.id,
      paperTitle: q.examPaper.title,
      level: q.examPaper.level ? parseLevel(q.examPaper.level) : null,
      subject: q.examPaper.subject,
      before: q.answer,
      after: normalized,
    });
  }

  return NextResponse.json({
    scannedCount: candidates.length,
    changedCount: rows.length,
    rows,
  });
}

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: { ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }
  const ids = (body.ids ?? []).filter((s): s is string => typeof s === "string" && s.length > 0);
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids required" }, { status: 400 });
  }
  if (ids.length > 1000) {
    return NextResponse.json({ error: "max 1000 ids per request" }, { status: 400 });
  }

  const rows = await prisma.examQuestion.findMany({
    where: { id: { in: ids } },
    select: { id: true, answer: true },
  });

  let updated = 0;
  const skipped: string[] = [];
  for (const r of rows) {
    if (!r.answer) {
      skipped.push(r.id);
      continue;
    }
    const { normalized, changed } = normaliseAnswerKeyFormat(r.answer);
    if (!changed) {
      skipped.push(r.id);
      continue;
    }
    await prisma.examQuestion.update({
      where: { id: r.id },
      data: { answer: normalized },
    });
    updated++;
  }

  return NextResponse.json({ updated, skipped: skipped.length });
}

// Levels are stored as "Primary 4" / "P4" / "4" depending on the source.
// Extract the digit so the UI can render "P4" consistently.
function parseLevel(level: string): number | null {
  const m = level.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
