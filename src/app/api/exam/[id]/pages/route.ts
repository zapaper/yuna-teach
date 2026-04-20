import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const page = request.nextUrl.searchParams.get("page");

  if (page === null) {
    // Return page count
    const dir = path.join(PAGES_DIR, id);
    try {
      const files = await fs.readdir(dir);
      const pageFiles = files.filter((f) => f.match(/^page_\d+\.jpg$/));
      return NextResponse.json({ pageCount: pageFiles.length });
    } catch {
      return NextResponse.json({ pageCount: 0 });
    }
  }

  const filePath = path.join(PAGES_DIR, id, `page_${page}.jpg`);
  try {
    const stat = await fs.stat(filePath);
    // ETag is based on mtime + size so that after a re-mask (file rewritten)
    // the ETag changes and caches invalidate immediately. Browsers still
    // cache but must revalidate on every request.
    const etag = `"${stat.mtimeMs.toFixed(0)}-${stat.size}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" },
      });
    }
    const buffer = await fs.readFile(filePath);
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=0, must-revalidate",
        ETag: etag,
      },
    });
  } catch {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }
}
