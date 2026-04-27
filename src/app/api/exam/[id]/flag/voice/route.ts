import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";

// POST /api/exam/[id]/flag/voice
// Multipart body: questionId, userId (optional), audio (Blob)
//
// The student / parent recorded a voice note while flagging a question.
// We persist the audio to disk and store the filename on the question
// row so a future review agent (or admin) can play it back. The flag
// itself is also raised here in the same call so the UI doesn't need
// two round trips.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const FLAG_VOICES_DIR = path.join(VOLUME_PATH, "flag-voices");

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const form = await request.formData();
  const questionId = form.get("questionId");
  const userIdRaw = form.get("userId");
  const audio = form.get("audio");

  if (typeof questionId !== "string" || !questionId) {
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
  }
  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: "audio file required" }, { status: 400 });
  }

  // Confirm the question belongs to this paper before writing anything.
  const question = await prisma.examQuestion.findFirst({
    where: { id: questionId, examPaperId: id },
    select: { id: true },
  });
  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  // Save the audio. The browser typically records as audio/webm or
  // audio/ogg depending on platform — pick the extension from the
  // mime type so we don't end up with files no player recognises.
  const mime = audio.type || "audio/webm";
  const ext = mime.includes("ogg") ? "ogg"
    : mime.includes("mp4") ? "m4a"
    : mime.includes("wav") ? "wav"
    : "webm";
  const dir = path.join(FLAG_VOICES_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${questionId}.${ext}`;
  const dest = path.join(dir, filename);
  const buffer = Buffer.from(await audio.arrayBuffer());
  await fs.writeFile(dest, buffer);

  // Raise the flag (or keep it raised) and store the filename so the
  // admin / agent knows where to look.
  const userId = typeof userIdRaw === "string" ? userIdRaw : null;
  await prisma.examQuestion.update({
    where: { id: questionId },
    data: {
      flagged: true,
      flaggedAt: new Date(),
      flaggedByUserId: userId,
      flagVoiceNote: filename,
    },
  });

  return NextResponse.json({ flagged: true, voice: filename });
}
