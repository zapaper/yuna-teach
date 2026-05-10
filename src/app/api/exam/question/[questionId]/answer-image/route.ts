import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// Serve the question's stored answerImageData (the answer-key
// crop or admin-supplied answer image) as a binary image
// response. Used by the admin answer-key-gaps page so the
// reviewer can see the original answer key image alongside the
// AI's proposed text key. Admin-only.
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
    select: { answerImageData: true },
  });
  if (!q?.answerImageData) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const match = q.answerImageData.match(/^data:(image\/[\w+-]+);base64,(.+)$/);
  const mime = match ? match[1] : "image/jpeg";
  const b64 = match ? match[2] : q.answerImageData.replace(/^data:[^,]+,/, "");
  return new NextResponse(Buffer.from(b64, "base64"), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "private, max-age=300",
    },
  });
}
