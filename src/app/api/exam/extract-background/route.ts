import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { prisma } from "@/lib/db";
import { extractExamPaperBackground } from "@/lib/extraction";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

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

    // Save page images to disk
    const pagesDir = path.join(PAGES_DIR, paper.id);
    await fs.mkdir(pagesDir, { recursive: true });
    for (let i = 0; i < images.length; i++) {
      const base64 = (images[i] as string).replace(
        /^data:image\/\w+;base64,/,
        ""
      );
      await fs.writeFile(
        path.join(pagesDir, `page_${i}.jpg`),
        Buffer.from(base64, "base64")
      );
    }

    // Fire-and-forget extraction
    extractExamPaperBackground(paper.id).catch((err) =>
      console.error(
        `[extract-background] Background extraction failed for ${paper.id}:`,
        err
      )
    );

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
