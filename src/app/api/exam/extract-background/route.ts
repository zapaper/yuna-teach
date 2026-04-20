import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import { prisma } from "@/lib/db";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

// CamScanner (and similar) watermarks sit in the bottom-right corner of every
// scanned page and confuse the AI during extraction/marking. Paint a plain
// white rectangle over that region on ingest so the watermark never survives
// into the pipeline. Dimensions are percentages of the page — easy to bump up
// if the watermark is bigger than the defaults.
const WATERMARK_MASK_BOTTOM_PCT = 0.04;
const WATERMARK_MASK_RIGHT_PCT = 0.25;

async function maskBottomRightCorner(buf: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(buf).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return buf;
    const maskW = Math.max(1, Math.ceil(W * WATERMARK_MASK_RIGHT_PCT));
    const maskH = Math.max(1, Math.ceil(H * WATERMARK_MASK_BOTTOM_PCT));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maskW}" height="${maskH}"><rect width="100%" height="100%" fill="white"/></svg>`;
    return await sharp(buf)
      .composite([{ input: Buffer.from(svg), left: W - maskW, top: H - maskH }])
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (err) {
    console.warn("[extract-background] watermark mask failed, writing original:", err);
    return buf;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { images, userId } = await request.json();

    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json(
        { error: "At least one image is required" },
        { status: 400 }
      );
    }
    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    // Create paper with processing status
    const paper = await prisma.examPaper.create({
      data: {
        title: "Processing...",
        pageCount: images.length,
        userId,
        extractionStatus: "processing",
      },
    });

    // Save page images to disk with the bottom-right corner masked (CamScanner watermark removal)
    const pagesDir = path.join(PAGES_DIR, paper.id);
    await fs.mkdir(pagesDir, { recursive: true });
    for (let i = 0; i < images.length; i++) {
      const base64 = (images[i] as string).replace(
        /^data:image\/\w+;base64,/,
        ""
      );
      const masked = await maskBottomRightCorner(Buffer.from(base64, "base64"));
      await fs.writeFile(path.join(pagesDir, `page_${i}.jpg`), masked);
    }

    // Extraction is triggered separately by the client after this response.
    // Keeping it out of this route avoids silent failures when large request bodies
    // hit network timeouts before this code would have been reached.
    return NextResponse.json({ id: paper.id }, { status: 201 });
  } catch (error) {
    console.error("Extract-background error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to start extraction",
      },
      { status: 500 }
    );
  }
}
