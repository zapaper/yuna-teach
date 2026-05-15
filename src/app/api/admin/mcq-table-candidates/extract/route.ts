import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { transcribeScienceMcqQuestion, DiagramBounds } from "@/lib/gemini";

async function cropDiagram(imageBase64: string, bounds: DiagramBounds): Promise<string> {
  const buf = Buffer.from(imageBase64, "base64");
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const PAD = 0.02;
  const left = Math.max(0, Math.round(((bounds.left / 100) - PAD) * w));
  const top = Math.max(0, Math.round(((bounds.top / 100) - PAD) * h));
  const right = Math.min(w, Math.round(((bounds.right / 100) + PAD) * w));
  const bottom = Math.min(h, Math.round(((bounds.bottom / 100) + PAD) * h));
  const width = Math.max(right - left, 1);
  const height = Math.max(bottom - top, 1);
  const out = await sharp(buf)
    .extract({ left, top, width, height })
    .grayscale().normalize().sharpen().jpeg({ quality: 90 }).toBuffer();
  return out.toString("base64");
}

// POST { questionId } → runs the science MCQ extractor on the saved image
// and returns whatever Gemini produces (optionTable, options, stem,
// diagram). UI inspects whether optionTable is non-null and offers
// Apply / Skip per question.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { questionId } = await request.json();
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });

  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: { imageData: true },
  });
  if (!q || !q.imageData) return NextResponse.json({ error: "No image data" }, { status: 404 });

  const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
  try {
    const r = await transcribeScienceMcqQuestion(base64);
    const diagramBase64 = r.diagram
      ? await cropDiagram(base64, r.diagram).catch(() => null)
      : null;
    return NextResponse.json({
      stem: r.stem,
      optionTable: r.optionTable,
      options: r.options,
      diagramBase64,
      diagramBounds: r.diagram,
    });
  } catch (err) {
    console.error("[mcq-table-candidates/extract] failed", err);
    return NextResponse.json({ error: "Extract failed" }, { status: 500 });
  }
}
