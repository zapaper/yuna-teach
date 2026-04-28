// Diagnostic onboarding flow.
//
// Parent emails a photo of any past paper to diagnose@inbound.markforyou.com.
// We extract the questions, infer the answer key, mark the student's work,
// classify topics, and reply with a weak-topic summary. The paper is saved
// as paperType: "diagnostic" and is visible only to the parent + that
// student + admin (via standard ownership rules).

import { promises as fs } from "fs";
import path from "path";
import sgMail from "@sendgrid/mail";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { renderPdfToJpegs } from "@/lib/pdf-server";
import { maskBottomRightCorner } from "@/lib/watermark";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

// Initialised lazily so missing env vars don't crash unrelated routes.
let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  return _ai;
}

let _sgConfigured = false;
function ensureSendGrid() {
  if (_sgConfigured) return;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error("SENDGRID_API_KEY is not set");
  sgMail.setApiKey(key);
  _sgConfigured = true;
}

const FROM_ADDRESS = process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com";
const FROM_NAME = "MarkForYou Diagnose";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.markforyou.com";

export type DiagnoseAttachment = { buf: Buffer; mime: string; name: string };
export type DiagnoseParent = {
  id: string;
  name: string | null;
  parentLinks: { studentId: string; student: { id: string; name: string; level: number | null } }[];
};

// Gemini's combined extract + answer-key + mark + topic-classify call,
// run once per page image. Output is a JSON array of question records.
type DiagnosedQuestion = {
  questionNum: string;
  stem: string;
  options?: string[];          // MCQ option texts ([] for OEQ)
  expectedAnswer: string;      // canonical answer (option letter for MCQ, text for OEQ)
  studentAnswer: string;       // what the student wrote (raw text), or "" if blank
  isCorrect: boolean;
  isBlank: boolean;
  feedback: string;            // 1-2 sentence explanation, used for the parent's review
  topic: string;               // single short topic label, e.g. "Fractions", "Photosynthesis"
  yStartPct: number;           // 0-100, top of the question region on the cropped page
  yEndPct: number;             // 0-100, bottom
};

async function diagnosePage(jpeg: Buffer, subjectHint: string, levelHint: string | null): Promise<DiagnosedQuestion[]> {
  const ai = getAI();
  const prompt = `You are reviewing one page of a Singapore primary-school past paper photographed by a parent. The student has handwritten answers on the paper.

CONTEXT:
- Subject (best guess from the page): ${subjectHint || "auto-detect"}
- Student level: ${levelHint ?? "unknown — primary school"}

TASK: For each distinct question on this page, output a JSON record. The record must include:
1. "questionNum": the printed number (e.g. "1", "12", "16a"). Use "?" if you can't tell.
2. "stem": the question text, transcribed verbatim.
3. "options": array of MCQ option texts (e.g. ["1/2", "1/3", "1/4", "1/5"]). Empty array for OEQ.
4. "expectedAnswer": the correct answer YOU determine. For MCQ, return the digit/letter of the correct option (e.g. "1", "2", or "A"). For OEQ, the expected text answer.
5. "studentAnswer": exactly what the student wrote in handwriting, transcribed. "" if blank.
6. "isCorrect": true if the student's answer matches the expected answer (allow synonyms / equivalent expressions). Strict for MCQ. Forgiving for OEQ phrasing.
7. "isBlank": true if the student wrote nothing.
8. "feedback": 1-2 sentence explanation suitable for showing the parent. Always include — even when correct.
9. "topic": ONE short topic label appropriate to the syllabus (e.g. "Fractions", "Decimals", "Photosynthesis", "Comprehension", "Synthesis & Transformation"). NOT a sentence.
10. "yStartPct" and "yEndPct": 0-100 vertical bounds of the question on the cropped image.

Skip cover pages, instructions, and any non-question content.

OUTPUT: a JSON array of question records. NO commentary.`;
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } },
        ],
      }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const raw = resp.text ?? "[]";
    const parsed = JSON.parse(raw) as DiagnosedQuestion[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(q => ({
      questionNum: String(q.questionNum ?? "?"),
      stem: String(q.stem ?? ""),
      options: Array.isArray(q.options) ? q.options.map(o => String(o)) : [],
      expectedAnswer: String(q.expectedAnswer ?? ""),
      studentAnswer: String(q.studentAnswer ?? ""),
      isCorrect: Boolean(q.isCorrect),
      isBlank: Boolean(q.isBlank),
      feedback: String(q.feedback ?? ""),
      topic: String(q.topic ?? "Uncategorised"),
      yStartPct: clamp(Number(q.yStartPct ?? 0), 0, 100),
      yEndPct: clamp(Number(q.yEndPct ?? 100), 0, 100),
    }));
  } catch (err) {
    console.error("[diagnose] page analysis failed:", err);
    return [];
  }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function pickStudent(parent: DiagnoseParent, subjectHintFromMail: string): { id: string; name: string; level: number | null } | null {
  const links = parent.parentLinks;
  if (links.length === 0) return null;
  // Subject-line student-name match: parent might write "Diagnose for John"
  // or "John's paper". Pick the first linked student whose name appears.
  const lower = subjectHintFromMail.toLowerCase();
  for (const l of links) {
    if (l.student.name && lower.includes(l.student.name.toLowerCase())) return l.student;
  }
  return links[0].student;
}

export async function handleDiagnostic(
  form: FormData,
  parent: DiagnoseParent,
  fromEmail: string,
): Promise<Response> {
  const subjectField = form.get("subject");
  const subjectStr = typeof subjectField === "string" ? subjectField : "";
  const student = pickStudent(parent, subjectStr);
  if (!student) {
    await maybeReply(fromEmail, "Diagnose: no student linked", "We couldn't find a child linked to your account. Sign up your child at " + APP_URL + " first, then resend the photo.").catch(() => {});
    return Response.json({ ok: true, ignored: "no linked student" });
  }

  // Collect attachments — same field convention as the scan flow.
  const attachments: DiagnoseAttachment[] = [];
  for (const [key, val] of form.entries()) {
    if (!key.startsWith("attachment")) continue;
    if (!(val instanceof Blob)) continue;
    const buf = Buffer.from(await val.arrayBuffer());
    const mime = (val as File).type || "application/octet-stream";
    const name = (val as File).name || `${key}.bin`;
    attachments.push({ buf, mime, name });
  }
  if (attachments.length === 0) {
    return Response.json({ ok: true, ignored: "no attachments" });
  }

  // Render every attachment to per-page JPGs and CamScanner-mask.
  const pageJpegs: Buffer[] = [];
  for (const a of attachments) {
    if (a.mime === "application/pdf") {
      try {
        const rendered = await renderPdfToJpegs(a.buf);
        for (const j of rendered) pageJpegs.push(await maskBottomRightCorner(j));
      } catch (err) {
        console.error(`[diagnose] PDF render failed for ${a.name}:`, err);
      }
    } else if (a.mime?.startsWith("image/")) {
      try {
        const norm = await sharp(a.buf).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
        pageJpegs.push(await maskBottomRightCorner(norm));
      } catch (err) {
        console.error(`[diagnose] sharp normalise failed for ${a.name}:`, err);
      }
    }
  }
  if (pageJpegs.length === 0) {
    return Response.json({ ok: true, ignored: "no usable pages" });
  }

  // Subject hint comes from the email subject — parent may write
  // "Math diagnostic" / "P5 science" / etc. Pure heuristic.
  const subjectHint = subjectStr.toLowerCase().includes("sci") ? "Science"
    : subjectStr.toLowerCase().includes("eng") ? "English"
    : subjectStr.toLowerCase().includes("math") ? "Mathematics"
    : "";
  const levelHint = student.level ? `Primary ${student.level}` : null;

  // Run Gemini diagnosis on every page in parallel.
  console.log(`[diagnose] analysing ${pageJpegs.length} pages for student=${student.id} (${student.name})`);
  const t0 = Date.now();
  const perPage = await Promise.all(pageJpegs.map(buf => diagnosePage(buf, subjectHint, levelHint)));
  console.log(`[diagnose] page analysis done in ${Date.now() - t0}ms`);
  const flat = perPage.flatMap((qs, pageIdx) => qs.map(q => ({ ...q, pageIndex: pageIdx })));
  if (flat.length === 0) {
    await maybeReply(fromEmail, "Diagnose: no questions detected", "We couldn't find any questions in the photos you sent. Try a clearer photo or PDF, with one full page per image.").catch(() => {});
    return Response.json({ ok: true, ignored: "no questions detected" });
  }

  // Materialise as an ExamPaper (paperType: "diagnostic"). Unlike scan
  // submissions, there's no master to clone from — this is a standalone
  // record. completedAt + markingStatus released so the student sees
  // results immediately, instantFeedback true for parity.
  const paper = await prisma.examPaper.create({
    data: {
      title: `Diagnostic — ${new Date().toLocaleDateString("en-SG", { day: "2-digit", month: "short", year: "numeric" })}`,
      subject: subjectHint || null,
      level: levelHint,
      paperType: "diagnostic",
      pageCount: pageJpegs.length,
      userId: parent.id,
      assignedToId: student.id,
      instantFeedback: true,
      completedAt: new Date(),
      markingStatus: "released",
      score: flat.filter(q => q.isCorrect).length,
      totalMarks: String(flat.length),
      metadata: { source: "diagnose-email", subjectHintFromEmail: subjectStr } as Prisma.InputJsonValue,
      questions: {
        create: flat.map((q, idx) => ({
          questionNum: q.questionNum,
          imageData: "", // populated later if needed; not required for review
          answer: q.expectedAnswer || null,
          pageIndex: q.pageIndex,
          orderIndex: idx,
          yStartPct: q.yStartPct,
          yEndPct: q.yEndPct,
          marksAvailable: 1,
          marksAwarded: q.isCorrect ? 1 : 0,
          studentAnswer: q.studentAnswer || null,
          markingNotes: q.feedback || null,
          syllabusTopic: q.topic || null,
          transcribedStem: q.stem || null,
          transcribedOptions: (q.options ?? []).length > 0 ? ((q.options ?? []) as Prisma.InputJsonValue) : Prisma.JsonNull,
        })),
      },
    },
    select: { id: true },
  });

  // Save the page JPGs so the review UI can render them as the
  // "submission" image — same convention the scan flow uses.
  const subDir = path.join(SUBMISSIONS_DIR, paper.id);
  await fs.mkdir(subDir, { recursive: true });
  for (let i = 0; i < pageJpegs.length; i++) {
    await fs.writeFile(path.join(subDir, `page_${i}.jpg`), pageJpegs[i]);
  }

  // Group by topic and pick weak ones (< 50% correct, at least 2 questions).
  const byTopic = new Map<string, { right: number; total: number }>();
  for (const q of flat) {
    const t = q.topic;
    const cur = byTopic.get(t) ?? { right: 0, total: 0 };
    cur.total++;
    if (q.isCorrect) cur.right++;
    byTopic.set(t, cur);
  }
  const weak: { topic: string; right: number; total: number }[] = [];
  const strong: { topic: string; right: number; total: number }[] = [];
  for (const [topic, s] of byTopic) {
    if (s.total >= 2 && s.right / s.total < 0.5) weak.push({ topic, ...s });
    else if (s.total >= 2 && s.right / s.total >= 0.8) strong.push({ topic, ...s });
  }

  await maybeReply(
    fromEmail,
    `Diagnose: ${student.name} — ${flat.filter(q => q.isCorrect).length}/${flat.length} correct`,
    buildSummaryHtml(student.name, flat.length, flat.filter(q => q.isCorrect).length, weak, strong, parent.id, paper.id),
    { html: true },
  ).catch((err) => console.error("[diagnose] reply email failed:", err));

  console.log(`[diagnose] paper=${paper.id} student=${student.id} score=${flat.filter(q => q.isCorrect).length}/${flat.length} weak=[${weak.map(w => w.topic).join(", ")}]`);

  return Response.json({
    ok: true,
    paperId: paper.id,
    studentId: student.id,
    score: flat.filter(q => q.isCorrect).length,
    total: flat.length,
    weakTopics: weak.map(w => w.topic),
  });
}

function buildSummaryHtml(
  studentName: string,
  total: number,
  correct: number,
  weak: { topic: string; right: number; total: number }[],
  strong: { topic: string; right: number; total: number }[],
  parentId: string,
  paperId: string,
): string {
  const dashboardUrl = `${APP_URL}/home/${parentId}?focusedSuggest=${encodeURIComponent(weak.map(w => w.topic).join(","))}`;
  const reviewUrl = `${APP_URL}/exam/${paperId}/review?userId=${parentId}`;
  const weakList = weak.length === 0
    ? "<p>No clear weak topics — the answers were spread fairly evenly. Nice work!</p>"
    : `<ul>${weak.map(w => `<li><strong>${escapeHtml(w.topic)}</strong> — ${w.right}/${w.total} correct</li>`).join("")}</ul>`;
  const strongList = strong.length === 0 ? "" : `<p><em>Strengths:</em> ${strong.map(s => escapeHtml(s.topic)).join(", ")}</p>`;
  return `<!doctype html><html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; color: #0b1c30;">
<h2 style="color: #001e40;">Diagnostic results for ${escapeHtml(studentName)}</h2>
<p>${correct} of ${total} questions correct.</p>
<h3 style="color: #001e40;">Topics to work on</h3>
${weakList}
${strongList}
<p style="margin-top: 28px;">
  <a href="${reviewUrl}" style="display:inline-block; background:#003366; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:bold;">See the marked paper</a>
  &nbsp;
  <a href="${dashboardUrl}" style="display:inline-block; background:#fff; color:#001e40; border:2px solid #001e40; padding:10px 16px; border-radius:10px; text-decoration:none; font-weight:bold;">Assign focused practice</a>
</p>
<p style="font-size: 12px; color: #43474f; margin-top: 32px;">The diagnostic paper has been added to ${escapeHtml(studentName)}'s activities. We've also tagged the weak topics — clicking <em>Assign focused practice</em> will pre-fill the topic selector.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function maybeReply(to: string, subject: string, body: string, opts: { html?: boolean } = {}) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn("[diagnose] SENDGRID_API_KEY not set — skipping reply email");
    return;
  }
  ensureSendGrid();
  const msg = opts.html
    ? { to, from: { email: FROM_ADDRESS, name: FROM_NAME }, subject, html: body }
    : { to, from: { email: FROM_ADDRESS, name: FROM_NAME }, subject, text: body };
  await sgMail.send(msg);
}
