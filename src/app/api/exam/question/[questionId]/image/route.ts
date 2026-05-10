import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// Serve an OEQ question's stored imageData (the clean-extract
// crop) as a binary image response. Used by the admin
// answer-key-gaps page so the reviewer can see the original
// question alongside the AI's proposed key without having to
// open the paper editor.
//
// Admin-only — the same data is exposed inline via /api/exam/[id]
// for paper participants, but this endpoint is for cross-paper
// lookups by question id.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ questionId: string }> },
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { questionId } = await params;
  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: { imageData: true },
  });
  if (!q?.imageData) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const match = q.imageData.match(/^data:(image\/[\w+-]+);base64,(.+)$/);
  const mime = match ? match[1] : "image/jpeg";
  const b64 = match ? match[2] : q.imageData.replace(/^data:[^,]+,/, "");
  return new NextResponse(Buffer.from(b64, "base64"), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "private, max-age=300",
    },
  });
}
