// Parent-facing Essay Coach — wraps the same compo-analysis pipeline
// that powers /admin/compo, but auth is session-user owns the attempt
// (uploaderId match), not admin role.
//
// GET  /api/essay-coach?studentId=<id>  — list this user's attempts,
//      optionally scoped to a single linked student.
// POST /api/essay-coach                  — multipart upload, same shape
//      as the admin POST plus a required studentId field.

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { COMPO_DIR } from "@/lib/compo-analysis";

async function ensureDir(d: string) {
  await fs.mkdir(d, { recursive: true });
}

function extOf(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const passthrough = [".pdf", ".docx", ".txt", ".jpg", ".jpeg", ".png", ".webp"];
  return passthrough.includes(ext) ? ext : ".jpg";
}

export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const studentId = req.nextUrl.searchParams.get("studentId");
  // Admins viewing another parent's essay-coach page (or a kid's) need
  // to see the essays uploaded by THAT parent, not by themselves.
  // Without this bypass, admin lands on /essay-coach/<other-parentId>
  // and sees an empty list because their own uploaderId never matches.
  // Non-admin callers stay locked to their own uploads.
  const where: { uploaderId?: string; studentId?: string } = {};
  if (!auth.isAdmin) where.uploaderId = auth.userId;
  if (studentId) where.studentId = studentId;

  const rows = await prisma.compoAttempt.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true, label: true, studentTopic: true, optionType: true,
      language: true, englishComponent: true,
      status: true, errorMessage: true, analysedAt: true,
      createdAt: true, updatedAt: true,
      critique: true, studentId: true,
    },
    take: 100,
  });

  // Admin-only for now: saved cross-essay coaching tips that were
  // generated FROM this student's essays. Surfaced on the parent
  // essay-coach index so a "Save this" press persists visually across
  // refreshes — without this, the result panel disappears and the
  // saved tip is only findable by drilling into one of the 4 essays.
  let tips: Array<{ id: string; createdAt: Date; language: string | null; attemptIds: unknown; analysis: unknown }> = [];
  if (auth.isAdmin && studentId) {
    tips = await prisma.$queryRaw<Array<{
      id: string;
      createdAt: Date;
      language: string | null;
      attemptIds: unknown;
      analysis: unknown;
    }>>(Prisma.sql`
      SELECT id, "createdAt", language, "attemptIds", analysis
      FROM batch_coach_tips
      WHERE "studentId" = ${studentId}
      ORDER BY "createdAt" DESC
      LIMIT 20
    `);
  }
  return NextResponse.json({ rows, tips });
}

export async function POST(req: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const form = await req.formData();
  const studentId = ((form.get("studentId") as string | null) ?? "").trim();
  if (!studentId) {
    return NextResponse.json({ error: "studentId is required" }, { status: 400 });
  }
  // Verify the student belongs to this parent (or that the caller IS
  // the student themselves — kid-account uploads aren't blocked).
  if (studentId !== auth.userId) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: auth.userId, studentId } },
      select: { id: true },
    });
    if (!link) return NextResponse.json({ error: "Student not linked" }, { status: 403 });
  }

  const label = ((form.get("label") as string | null) ?? "").trim() || null;
  const studentTopic = ((form.get("studentTopic") as string | null) ?? "").trim() || null;
  const optionTypeRaw = ((form.get("optionType") as string | null) ?? "").trim();
  const optionType = optionTypeRaw === "option1" || optionTypeRaw === "option2" ? optionTypeRaw : null;
  const languageRaw = ((form.get("language") as string | null) ?? "").trim().toLowerCase();
  const language = languageRaw === "english" || languageRaw === "chinese" ? languageRaw : null;
  const englishComponentRaw = ((form.get("englishComponent") as string | null) ?? "").trim().toLowerCase();
  const englishComponent =
    language === "english" && (englishComponentRaw === "continuous" || englishComponentRaw === "situational")
      ? englishComponentRaw
      : null;
  const compareToMarkings = String(form.get("compareToMarkings") ?? "").toLowerCase() === "true";
  const pageEntries = form.getAll("pages");

  const pageFiles = pageEntries.filter((p): p is File => p instanceof File);
  if (pageFiles.length === 0) {
    return NextResponse.json({ error: "At least one composition page is required" }, { status: 400 });
  }

  const attempt = await prisma.compoAttempt.create({
    data: {
      uploaderId: auth.userId,
      studentId,
      label,
      studentTopic,
      optionType,
      language,
      englishComponent,
      compareToMarkings,
      compositionImagePaths: [],
      status: "uploaded",
    },
  });
  const attemptDir = path.join(COMPO_DIR, attempt.id);
  await ensureDir(attemptDir);

  const relPaths: string[] = [];
  for (let i = 0; i < pageFiles.length; i++) {
    const f = pageFiles[i];
    const ext = extOf(f.name);
    const rel = path.posix.join(attempt.id, `page_${i + 1}${ext}`);
    const abs = path.join(COMPO_DIR, rel);
    const buf = Buffer.from(await f.arrayBuffer());
    await fs.writeFile(abs, buf);
    relPaths.push(rel);
  }

  const updated = await prisma.compoAttempt.update({
    where: { id: attempt.id },
    data: { compositionImagePaths: relPaths as never },
  });

  return NextResponse.json({ row: updated });
}
