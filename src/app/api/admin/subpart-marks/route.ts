import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractSubpartMarks } from "@/lib/gemini";
import { Prisma } from "@prisma/client";

import { isSessionAdmin } from "@/lib/session";

type Subpart = { label: string; text: string; diagramBase64?: string | null };

function subsNeedMarks(subs: unknown): Subpart[] {
  if (!Array.isArray(subs)) return [];
  const real = subs.filter((s: Subpart) => s && typeof s.label === "string" && !s.label.startsWith("_"));
  // needs marks if NONE of the sub-parts have a [N] marker
  const anyWithMarks = real.some((s: Subpart) => /\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i.test(String(s.text ?? "")));
  return anyWithMarks ? [] : real;
}

// GET → count affected questions (optionally filter by subject)
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const subject = request.nextUrl.searchParams.get("subject")?.toLowerCase() ?? null;

  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        ...(subject ? { subject: { contains: subject, mode: "insensitive" } } : {}),
      },
      transcribedSubparts: { not: Prisma.JsonNull },
      imageData: { not: "" },
    },
    include: { examPaper: { select: { subject: true, title: true } } },
  });

  const affected = qs.filter(q => subsNeedMarks(q.transcribedSubparts).length > 0);
  const bySubject: Record<string, number> = {};
  for (const q of affected) {
    const subj = (q.examPaper.subject ?? "unknown").toLowerCase().includes("math") ? "math"
      : (q.examPaper.subject ?? "").toLowerCase().includes("science") ? "science"
      : (q.examPaper.subject ?? "").toLowerCase().includes("english") ? "english" : "other";
    bySubject[subj] = (bySubject[subj] ?? 0) + 1;
  }
  return NextResponse.json({ total: affected.length, bySubject, ids: affected.slice(0, 200).map(q => q.id) });
}

// POST { ids: [...] } → process in sequence, update transcribedSubparts
export async function POST(request: NextRequest) {
  const { userId, ids } = await request.json() as { userId: string; ids: string[] };
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });

  const results: { id: string; updated: number; marks?: Record<string, number>; error?: string }[] = [];
  for (const id of ids) {
    const q = await prisma.examQuestion.findUnique({
      where: { id },
      select: { id: true, transcribedSubparts: true, imageData: true },
    });
    if (!q || !q.imageData || !q.transcribedSubparts) { results.push({ id, updated: 0, error: "missing data" }); continue; }
    const real = subsNeedMarks(q.transcribedSubparts);
    if (real.length === 0) { results.push({ id, updated: 0, error: "no subparts need marks" }); continue; }
    const labels = real.map(s => s.label);

    // Strip data URI prefix if present
    const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
    const marks = await extractSubpartMarks(base64, labels);

    if (Object.keys(marks).length === 0) { results.push({ id, updated: 0, error: "AI could not read marks" }); continue; }

    // Update subparts: append [N] to the text if AI found marks for that label
    const existing = q.transcribedSubparts as unknown as Subpart[];
    const updatedSubparts = existing.map(sp => {
      if (sp.label.startsWith("_")) return sp;
      const m = marks[sp.label];
      if (!m) return sp;
      // Only append if text doesn't already have [N]
      if (/\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i.test(String(sp.text ?? ""))) return sp;
      const newText = `${String(sp.text ?? "").trim()} [${m}]`.trim();
      return { ...sp, text: newText };
    });

    await prisma.examQuestion.update({
      where: { id },
      data: { transcribedSubparts: updatedSubparts as unknown as object },
    });
    results.push({ id, updated: Object.keys(marks).length, marks });
  }

  return NextResponse.json({ results });
}
