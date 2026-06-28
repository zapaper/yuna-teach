// /api/admin/compo
//   GET  — list all attempts, newest first.
//   POST — multipart form upload:
//          {
//            label?: string,
//            studentTopic?: string,
//            optionType?: "option1" | "option2",
//            question?: File | null,
//            pages: File[]  (1+)
//          }
//          Saves each page under VOLUME_PATH/compo/<id>/page_<N>.<ext>,
//          creates the row, returns it. Analysis is NOT run here — the
//          /[id]/analyse endpoint kicks off the pipeline so the upload
//          POST returns quickly.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";
import { COMPO_DIR } from "@/lib/compo-analysis";

async function ensureDir(d: string) {
  await fs.mkdir(d, { recursive: true });
}

function extOf(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  // Preserve .pdf / .docx / .txt so the analysis pipeline can route
  // them correctly (text formats skip OCR; PDF + images use Gemini).
  // Anything else defaults to .jpg as a best-effort fallback.
  const passthrough = [".pdf", ".docx", ".txt", ".jpg", ".jpeg", ".png", ".webp"];
  return passthrough.includes(ext) ? ext : ".jpg";
}

export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rows = await prisma.compoAttempt.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true, label: true, studentTopic: true, optionType: true,
      language: true, englishComponent: true,
      status: true, errorMessage: true, analysedAt: true,
      createdAt: true, updatedAt: true,
      critique: true,
    },
    take: 100,
  });
  return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const uploaderId = await getSessionUserId();

  const form = await req.formData();
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
  const questionFile = form.get("question");
  const pageEntries = form.getAll("pages");

  const pageFiles = pageEntries.filter((p): p is File => p instanceof File);
  if (pageFiles.length === 0) {
    return NextResponse.json({ error: "At least one composition page is required" }, { status: 400 });
  }

  // Create the row first so we have the id for the file paths.
  const attempt = await prisma.compoAttempt.create({
    data: {
      uploaderId,
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

  // Write each page.
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

  let questionRel: string | null = null;
  if (questionFile instanceof File) {
    const ext = extOf(questionFile.name);
    questionRel = path.posix.join(attempt.id, `question${ext}`);
    const buf = Buffer.from(await questionFile.arrayBuffer());
    await fs.writeFile(path.join(COMPO_DIR, questionRel), buf);
  }

  const updated = await prisma.compoAttempt.update({
    where: { id: attempt.id },
    data: {
      compositionImagePaths: relPaths as never,
      questionImagePath: questionRel,
    },
  });

  return NextResponse.json({ row: updated });
}
