import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function submissionDir(id: string) {
  return path.join(SUBMISSIONS_DIR, id);
}

// GET /api/exam/[id]/submission
//   ?page=N  → serve the composite JPEG for page N
//   (none)   → return { pageCount, submittedAt }
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const pageStr = request.nextUrl.searchParams.get("page");

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { completedAt: true },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const dir = submissionDir(id);

  if (pageStr !== null) {
    const n = parseInt(pageStr, 10);
    if (isNaN(n)) {
      return NextResponse.json({ error: "Invalid page" }, { status: 400 });
    }
    const type = request.nextUrl.searchParams.get("type");
    const isInk = type === "ink";
    const filePath = isInk
      ? path.join(dir, `page_${n}_ink.png`)
      : path.join(dir, `page_${n}.jpg`);
    try {
      const buffer = await fs.readFile(filePath);
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": isInk ? "image/png" : "image/jpeg",
          "Cache-Control": "private, no-cache",
        },
      });
    } catch {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }
  }

  // Return metadata
  let pageCount = 0;
  try {
    const files = await fs.readdir(dir);
    pageCount = files.filter(
      (f) => f.startsWith("page_") && f.endsWith(".jpg")
    ).length;
  } catch {
    // directory doesn't exist yet
  }

  return NextResponse.json({
    pageCount,
    submittedAt: paper.completedAt?.toISOString() ?? null,
  });
}

// POST /api/exam/[id]/submission
//   Body: multipart form
//     action: "save" | "submit"
//     page_0, page_1, … : JPEG files
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const formData = await request.formData();
  const action = formData.get("action") as string;

  const dir = submissionDir(id);
  await ensureDir(dir);

  let pageCount = 0;
  for (const [key, value] of formData.entries()) {
    if (!(value instanceof File)) continue;
    if (key.startsWith("page_") && key.endsWith("_ink")) {
      // Ink-only PNG (for reload)
      const n = key.slice(5, -4); // "page_0_ink" → "0"
      const buffer = Buffer.from(await value.arrayBuffer());
      await fs.writeFile(path.join(dir, `page_${n}_ink.png`), buffer);
    } else if (key.startsWith("page_")) {
      // Composite JPEG (for parent viewing)
      const n = key.slice(5); // "page_0" → "0"
      const buffer = Buffer.from(await value.arrayBuffer());
      await fs.writeFile(path.join(dir, `page_${n}.jpg`), buffer);
      pageCount++;
    }
  }

  if (action === "submit") {
    await prisma.examPaper.update({
      where: { id },
      data: { completedAt: new Date() },
    });
  }

  return NextResponse.json({ success: true, pageCount });
}
