import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { prisma } from "@/lib/db";
import { maskBottomRightCorner } from "@/lib/watermark";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

// Re-applies the CamScanner watermark mask to every page image of an existing
// paper. Useful after bumping the mask dimensions or for papers ingested
// before masking existed. Destructive — overwrites the page files in place.
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, pageCount: true, title: true },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  const pagesDir = path.join(PAGES_DIR, paper.id);
  let masked = 0;
  let skipped = 0;
  for (let i = 0; i < paper.pageCount; i++) {
    const filePath = path.join(pagesDir, `page_${i}.jpg`);
    try {
      const buf = await fs.readFile(filePath);
      const out = await maskBottomRightCorner(buf);
      await fs.writeFile(filePath, out);
      masked++;
    } catch {
      skipped++;
    }
  }
  return NextResponse.json({ paperId: paper.id, title: paper.title, masked, skipped });
}
