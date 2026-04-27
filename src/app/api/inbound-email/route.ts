import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { markExamPaper } from "@/lib/marking";

// SendGrid Inbound Parse webhook.
// Parents scan their printed exam paper, email it to hello@markforyou.com.
// SendGrid posts a multipart/form-data payload here with fields:
//   from, to, subject, text, html
//   attachments (count), attachment1..N (Files)
//   attachment-info (JSON metadata), envelope (JSON), charsets (JSON)
//
// We:
//  1. Look up the parent by sender email (case-insensitive).
//  2. Pull every attached image / PDF page out into JPEGs.
//  3. Ask Gemini to find the print code 'MFY-<8>-<8>' on the first page.
//  4. Decode → master paperId prefix + studentId prefix.
//  5. Find the matching master paper + verify the parent has access to
//     that student.
//  6. Create a clone (paperType: null, sourceExamId, assignedToId,
//     completedAt). Save attachments under submissions/<cloneId>/.
//  7. Trigger marking via markExamPaper.
//
// Returns 200 on every path so SendGrid doesn't retry — failures are
// logged for the operator to investigate.

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  return _ai;
}

// SendGrid sends 'from' as 'Display Name <email@host>' OR just the
// email. Strip to the bare address, lowercased.
function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/) ?? [null, raw];
  return (m[1] ?? "").trim().toLowerCase() || null;
}

async function readPageOneAsJpeg(buf: Buffer, mime: string | undefined): Promise<Buffer | null> {
  // Image: re-encode to a manageable JPEG so Gemini doesn't choke.
  if (mime?.startsWith("image/")) {
    return sharp(buf).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  }
  // PDF: render the first page via pdf-lib + sharp. We don't have pdfjs
  // server-side — fall back to using the PDF as-is and let Gemini's
  // multimodal accept the PDF directly. Gemini 2.5 supports PDF input.
  if (mime === "application/pdf") {
    return buf; // pass through, return as PDF
  }
  // Unknown — skip
  return null;
}

async function extractCodeFromPage(jpegOrPdf: Buffer, isPdf: boolean): Promise<string | null> {
  const ai = getAI();
  const text = `Find the print code on this exam page. The code is on the top-right of page 1 and looks exactly like 'MFY-XXXXXXXX-XXXXXXXX' (each X is an alphanumeric character). Return ONLY the code, nothing else. If not found, return 'NONE'.`;
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text },
            {
              inlineData: {
                mimeType: isPdf ? "application/pdf" : "image/jpeg",
                data: jpegOrPdf.toString("base64"),
              },
            },
          ],
        },
      ],
      config: { temperature: 0 },
    });
    const out = (resp.text ?? "").trim();
    const match = out.match(/MFY-[A-Za-z0-9]{8}-[A-Za-z0-9]{8}/);
    return match ? match[0] : null;
  } catch (err) {
    console.error("[inbound-email] code OCR failed:", err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error("[inbound-email] failed to parse form:", err);
    return NextResponse.json({ ok: false, error: "bad form" }, { status: 200 });
  }

  const fromRaw = form.get("from");
  const fromEmail = normaliseEmail(typeof fromRaw === "string" ? fromRaw : null);
  const subject = form.get("subject");
  console.log(`[inbound-email] from=${fromEmail} subject=${typeof subject === "string" ? subject : ""}`);

  if (!fromEmail) {
    console.warn("[inbound-email] no sender — dropping");
    return NextResponse.json({ ok: true, ignored: "no sender" });
  }

  const parent = await prisma.user.findFirst({
    where: { email: { equals: fromEmail, mode: "insensitive" } },
    select: { id: true, name: true, role: true, parentLinks: { select: { studentId: true } } },
  });
  if (!parent) {
    console.warn(`[inbound-email] no registered user for ${fromEmail} — dropping`);
    return NextResponse.json({ ok: true, ignored: "unknown sender" });
  }

  // Collect attachments (any file field whose name starts with 'attachment').
  type Attach = { buf: Buffer; mime: string; name: string };
  const attachments: Attach[] = [];
  for (const [key, val] of form.entries()) {
    if (!key.startsWith("attachment")) continue;
    if (!(val instanceof Blob)) continue;
    const buf = Buffer.from(await val.arrayBuffer());
    const mime = (val as File).type || "application/octet-stream";
    const name = (val as File).name || `${key}.bin`;
    attachments.push({ buf, mime, name });
  }
  if (attachments.length === 0) {
    console.warn(`[inbound-email] no attachments from ${fromEmail} — dropping`);
    return NextResponse.json({ ok: true, ignored: "no attachments" });
  }

  // Use the first attachment for code detection. If it's a PDF we send
  // it whole to Gemini; if it's an image, re-encode for size.
  const first = attachments[0];
  const firstForOcr = await readPageOneAsJpeg(first.buf, first.mime);
  if (!firstForOcr) {
    console.warn(`[inbound-email] first attachment unsupported mime ${first.mime}`);
    return NextResponse.json({ ok: true, ignored: "unsupported mime" });
  }
  const code = await extractCodeFromPage(firstForOcr, first.mime === "application/pdf");
  if (!code) {
    console.warn(`[inbound-email] no print code detected on first page (from=${fromEmail})`);
    return NextResponse.json({ ok: true, ignored: "no code" });
  }
  // Format: MFY-<paper8>-<student8>
  const m = code.match(/^MFY-([A-Za-z0-9]{8})-([A-Za-z0-9]{8})$/);
  if (!m) {
    console.warn(`[inbound-email] code malformed: ${code}`);
    return NextResponse.json({ ok: true, ignored: "bad code" });
  }
  const [, paperPrefix, studentPrefix] = m;

  const masterPaper = await prisma.examPaper.findFirst({
    where: { id: { startsWith: paperPrefix }, sourceExamId: null },
    select: { id: true, title: true, subject: true, level: true, examType: true, paperType: true, totalMarks: true, metadata: true, pageCount: true, instantFeedback: true, userId: true, questions: { orderBy: { orderIndex: "asc" } } },
  });
  if (!masterPaper) {
    console.warn(`[inbound-email] no master paper for prefix ${paperPrefix}`);
    return NextResponse.json({ ok: true, ignored: "paper not found" });
  }
  const linkedStudentIds = parent.parentLinks.map(l => l.studentId);
  const student = await prisma.user.findFirst({
    where: { id: { startsWith: studentPrefix }, ...(parent.name?.toLowerCase() === "admin" ? {} : { id: { in: linkedStudentIds } }) },
    select: { id: true, name: true },
  });
  if (!student) {
    console.warn(`[inbound-email] no linked student for prefix ${studentPrefix} (parent=${parent.id})`);
    return NextResponse.json({ ok: true, ignored: "student not found" });
  }

  console.log(`[inbound-email] matched paper=${masterPaper.id} student=${student.id} from ${fromEmail}; ${attachments.length} attachments`);

  // Create the clone. Mirrors the assign + complete flow used by the
  // normal in-app submission path.
  const clone = await prisma.examPaper.create({
    data: {
      title: masterPaper.title,
      subject: masterPaper.subject,
      level: masterPaper.level,
      examType: masterPaper.examType,
      totalMarks: masterPaper.totalMarks,
      metadata: masterPaper.metadata ?? Prisma.JsonNull,
      pageCount: masterPaper.pageCount,
      instantFeedback: masterPaper.instantFeedback,
      userId: masterPaper.userId,
      assignedToId: student.id,
      sourceExamId: masterPaper.id,
      paperType: masterPaper.paperType,
      completedAt: new Date(),
      markingStatus: "in_progress",
      questions: {
        create: masterPaper.questions.map((q) => ({
          questionNum: q.questionNum,
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          pageIndex: q.pageIndex,
          orderIndex: q.orderIndex,
          yStartPct: q.yStartPct,
          yEndPct: q.yEndPct,
          marksAvailable: q.marksAvailable,
          syllabusTopic: q.syllabusTopic,
          transcribedStem: q.transcribedStem,
          transcribedOptions: (q.transcribedOptions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          transcribedOptionImages: (q.transcribedOptionImages ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          transcribedSubparts: (q.transcribedSubparts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          diagramImageData: q.diagramImageData,
          diagramBounds: (q.diagramBounds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          sourceQuestionId: q.id,
        })),
      },
    },
    select: { id: true },
  });

  // Save attachments under submissions/<cloneId>/page_N.jpg. PDFs get
  // each page extracted at marking time by the existing pipeline; for
  // now we save them with their original extension and let downstream
  // image-only paths handle the JPEGs.
  const subDir = path.join(SUBMISSIONS_DIR, clone.id);
  await fs.mkdir(subDir, { recursive: true });
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    const ext = a.mime === "application/pdf" ? "pdf"
      : a.mime?.includes("png") ? "png"
      : "jpg";
    let bufToSave = a.buf;
    if (ext === "jpg" || ext === "png") {
      // Normalise to a manageable size + JPEG.
      try {
        bufToSave = await sharp(a.buf).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
      } catch { /* keep original */ }
    }
    const dest = path.join(subDir, `page_${i}.${ext === "png" ? "jpg" : ext}`);
    await fs.writeFile(dest, bufToSave);
  }

  // Kick off marking in the background — don't block the webhook.
  markExamPaper(clone.id).catch(err => {
    console.error(`[inbound-email] markExamPaper failed for ${clone.id}:`, err);
  });

  return NextResponse.json({
    ok: true,
    paperId: clone.id,
    student: student.name,
    attachmentCount: attachments.length,
  });
}
