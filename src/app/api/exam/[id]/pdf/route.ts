import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";

// In Railway, set VOLUME_PATH to the mount path of the persistent volume (e.g. /data).
// In development it falls back to .data/ inside the project root.
const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PDFS_DIR = path.join(VOLUME_PATH, "pdfs");

async function ensurePdfsDir() {
  await fs.mkdir(PDFS_DIR, { recursive: true });
}

// GET /api/exam/[id]/pdf  — serve the stored PDF
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { pdfPath: true },
  });

  if (!paper?.pdfPath) {
    return NextResponse.json({ error: "No PDF stored" }, { status: 404 });
  }

  try {
    const buffer = await fs.readFile(paper.pdfPath);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="exam-${id}.pdf"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "PDF file not found" }, { status: 404 });
  }
}

// POST /api/exam/[id]/pdf  — save uploaded PDF to volume
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const formData = await request.formData();
  const file = formData.get("pdf");

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "pdf field required" }, { status: 400 });
  }

  await ensurePdfsDir();

  const filePath = path.join(PDFS_DIR, `${id}.pdf`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filePath, buffer);

  await prisma.examPaper.update({
    where: { id },
    data: { pdfPath: filePath },
  });

  return NextResponse.json({ success: true, pdfPath: filePath });
}
