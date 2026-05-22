import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/admin/chinese-drafts?status=pending
//   List drafts. Default: pending only, ordered by priority asc.
//
// POST /api/admin/chinese-drafts
//   body: { id: string, action: "keep" | "drop" }
//   keep: status → "kept", insert a real ExamQuestion in the Chinese
//         synthetic bank paper, save promotedQuestionId.
//   drop: status → "dropped" (audit-preserved, but never re-shown).

const BANK_TITLE = "[Synthetic Bank] Chinese Primary 6";

async function getOrCreateBankPaper(adminUserId: string): Promise<string> {
  const existing = await prisma.examPaper.findFirst({
    where: { title: BANK_TITLE, paperType: null, sourceExamId: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.examPaper.create({
    data: {
      title: BANK_TITLE, subject: "Chinese", level: "Primary 6", userId: adminUserId,
      pageCount: 0, paperType: null, sourceExamId: null,
      extractionStatus: "ready", visible: true, examType: "Synthetic",
    },
    select: { id: true },
  });
  return created.id;
}

export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const status = request.nextUrl.searchParams.get("status") ?? "pending";
  const rows = await prisma.chineseMcqDraft.findMany({
    where: { status },
    orderBy: [{ priority: "asc" }, { shape: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, seedWord: true, seedMeaning: true, shape: true, stem: true,
      options: true, correctAnswer: true, explanation: true, syllabusTopic: true,
      subTopic: true, priority: true, status: true, promotedQuestionId: true,
    },
  });
  // Summary counts for the header
  const counts = await prisma.chineseMcqDraft.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const countsMap: Record<string, number> = {};
  for (const c of counts) countsMap[c.status] = c._count._all;
  return NextResponse.json({ drafts: rows, counts: countsMap });
}

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { id?: string; action?: string };
  const { id, action } = body;
  if (!id || (action !== "keep" && action !== "drop")) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const draft = await prisma.chineseMcqDraft.findUnique({ where: { id } });
  if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  if (draft.status !== "pending") {
    return NextResponse.json({ error: `Draft already ${draft.status}` }, { status: 409 });
  }

  if (action === "drop") {
    await prisma.chineseMcqDraft.update({ where: { id }, data: { status: "dropped" } });
    return NextResponse.json({ ok: true, status: "dropped" });
  }

  // action === "keep" — find admin, get/create bank, insert ExamQuestion.
  const admin = await prisma.user.findFirst({
    where: {
      OR: [
        { name: { equals: "admin", mode: "insensitive" } },
        { settings: { path: ["admin"], equals: true } as never },
      ],
    },
    select: { id: true },
  });
  if (!admin) return NextResponse.json({ error: "No admin user" }, { status: 500 });

  const bankPaperId = await getOrCreateBankPaper(admin.id);
  const existingCount = await prisma.examQuestion.count({ where: { examPaperId: bankPaperId } });

  const created = await prisma.examQuestion.create({
    data: {
      questionNum: `S${existingCount + 1}`,
      imageData: "",
      answer: `(${draft.correctAnswer})`,
      pageIndex: 0,
      orderIndex: existingCount + 1,
      marksAvailable: 2,
      examPaperId: bankPaperId,
      syllabusTopic: draft.syllabusTopic,
      subTopic: draft.subTopic,
      transcribedStem: draft.stem,
      transcribedOptions: draft.options as never,
      elaboration: draft.explanation,
    },
    select: { id: true },
  });

  await prisma.chineseMcqDraft.update({
    where: { id },
    data: { status: "kept", promotedQuestionId: created.id },
  });
  return NextResponse.json({ ok: true, status: "kept", questionId: created.id });
}
