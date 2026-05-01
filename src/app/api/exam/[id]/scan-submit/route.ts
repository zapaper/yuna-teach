import { NextRequest, NextResponse } from "next/server";
import { submitScannedPaper } from "@/lib/scan-submit";

// POST /api/exam/[id]/scan-submit?userId=<parentId>
//
// In-app camera-scan flow. Multipart form with:
//   - studentId: id of the assigned student
//   - page_0, page_1, ...: JPEG/PNG blobs in display order
//
// We hand the buffers to submitScannedPaper which clones the master,
// saves the pages with watermark masking, and kicks off marking. Same
// helper the SendGrid inbound webhook uses, so behaviour is identical
// to the email path.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: paperId } = await params;
  const parentId = request.nextUrl.searchParams.get("userId");
  if (!parentId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error("[scan-submit] failed to parse form:", err);
    return NextResponse.json({ error: "bad form" }, { status: 400 });
  }

  const studentIdRaw = form.get("studentId");
  const studentId = typeof studentIdRaw === "string" ? studentIdRaw.trim() : "";
  if (!studentId) return NextResponse.json({ error: "studentId required" }, { status: 400 });

  // Collect every page_<n> field, sorted numerically so we honour the
  // order the client sent rather than form-data iteration order.
  const pages: { idx: number; buf: Buffer }[] = [];
  for (const [key, val] of form.entries()) {
    const m = key.match(/^page_(\d+)$/);
    if (!m) continue;
    if (!(val instanceof Blob)) continue;
    const mime = (val as File).type ?? "";
    if (!mime.startsWith("image/")) continue;
    const buf = Buffer.from(await val.arrayBuffer());
    pages.push({ idx: parseInt(m[1], 10), buf });
  }
  if (pages.length === 0) {
    return NextResponse.json({ error: "no pages" }, { status: 400 });
  }
  pages.sort((a, b) => a.idx - b.idx);
  const jpegBuffers = pages.map((p) => p.buf);

  try {
    const { cloneId, pageCount } = await submitScannedPaper({
      parentId,
      paperId,
      studentId,
      jpegBuffers,
    });
    return NextResponse.json({ cloneId, pageCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "submit failed";
    console.error(`[scan-submit] parent=${parentId} paper=${paperId} student=${studentId} failed:`, err);
    // Map known auth/validation messages to 4xx; everything else is 500.
    if (
      msg === "parent not found" ||
      msg === "parent not linked to student" ||
      msg === "paper assigned to a different student"
    ) {
      return NextResponse.json({ error: msg }, { status: 403 });
    }
    if (msg === "paper not found" || msg === "master paper not found") {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg === "no pages" || msg === "no usable pages") {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
