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
  // "answer" — Before/After is the answer-key string.
  // "stem"   — Before/After is the question's transcribedStem; same
  //            sub-part label rules apply (the malformed "(b(i))" /
  //            "Q7(a)" patterns show up in stems too).
  field: "answer" | "stem";
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
        // No subject filter — Chinese / English answer keys and stems
        // hit the same "Q7(a)" / "(b(i))" sub-part rewrite patterns.
        NOT: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
      OR: [
        { answer: { not: null } },
        { transcribedStem: { not: null } },
      ],
    },
    select: {
      id: true,
      questionNum: true,
      answer: true,
      transcribedStem: true,
      examPaper: { select: { id: true, title: true, level: true, subject: true } },
    },
    orderBy: { id: "asc" },
    take: 5000,
  });

  const rows: Row[] = [];
  for (const q of candidates) {
    if (q.answer) {
      const { normalized, changed } = normaliseAnswerKeyFormat(q.answer);
      if (changed) {
        rows.push({
          id: q.id,
          questionNum: q.questionNum,
          paperId: q.examPaper.id,
          paperTitle: q.examPaper.title,
          level: q.examPaper.level ? parseLevel(q.examPaper.level) : null,
          subject: q.examPaper.subject,
          field: "answer",
          before: q.answer,
          after: normalized,
        });
      }
    }
    if (q.transcribedStem) {
      const { normalized, changed } = normaliseAnswerKeyFormat(q.transcribedStem);
      if (changed) {
        rows.push({
          id: q.id,
          questionNum: q.questionNum,
          paperId: q.examPaper.id,
          paperTitle: q.examPaper.title,
          level: q.examPaper.level ? parseLevel(q.examPaper.level) : null,
          subject: q.examPaper.subject,
          field: "stem",
          before: q.transcribedStem,
          after: normalized,
        });
      }
    }
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
  let body: { ids?: string[]; updates?: Array<{ id: string; field?: "answer" | "stem"; answer?: string; stem?: string; text?: string }> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }

  // Two modes:
  //   { updates: [{ id, field, text }] } — write the supplied text
  //     verbatim into either `answer` (field="answer") or
  //     `transcribedStem` (field="stem"). Used when the admin edited
  //     the proposed "After" cell before applying. Legacy callers can
  //     still pass `answer` instead of `text` — both are accepted and
  //     default the field to "answer".
  //   { ids: [...] }                    — re-run the normaliser on
  //     each question's current `answer` DB value (legacy bulk-apply
  //     path, stems are not touched here).
  // updates takes precedence if both are supplied.
  if (body.updates && Array.isArray(body.updates) && body.updates.length > 0) {
    if (body.updates.length > 1000) {
      return NextResponse.json({ error: "max 1000 updates per request" }, { status: 400 });
    }
    let updated = 0;
    for (const u of body.updates) {
      if (typeof u.id !== "string") continue;
      const field = u.field ?? "answer";
      const text = u.text ?? u.answer ?? u.stem;
      if (typeof text !== "string") continue;
      await prisma.examQuestion.update({
        where: { id: u.id },
        data: field === "stem" ? { transcribedStem: text } : { answer: text },
      });
      updated++;
    }
    return NextResponse.json({ updated, skipped: 0 });
  }

  const ids = (body.ids ?? []).filter((s): s is string => typeof s === "string" && s.length > 0);
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids or updates required" }, { status: 400 });
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
