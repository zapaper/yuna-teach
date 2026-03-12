import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { prisma } from "@/lib/db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { questionId, bounds } = await req.json() as {
    questionId: string;
    bounds: { top: number; left: number; bottom: number; right: number };
  };

  const q = await prisma.examQuestion.findFirst({
    where: { id: questionId, examPaperId: id },
    select: { imageData: true },
  });
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
  const buf = Buffer.from(base64, "base64");
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  const left = Math.max(0, Math.round((bounds.left / 100) * w));
  const top = Math.max(0, Math.round((bounds.top / 100) * h));
  const right = Math.min(w, Math.round((bounds.right / 100) * w));
  const bottom = Math.min(h, Math.round((bounds.bottom / 100) * h));
  const width = Math.max(right - left, 1);
  const height = Math.max(bottom - top, 1);

  const cropped = await sharp(buf)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .sharpen()
    .jpeg({ quality: 90 })
    .toBuffer();

  return NextResponse.json({ diagramBase64: cropped.toString("base64") });
}
