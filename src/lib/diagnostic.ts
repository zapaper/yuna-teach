// Diagnostic onboarding flow.
//
// Parent emails a photo of any past paper to diagnose@inbound.markforyou.com.
// We extract the questions, infer the answer key, mark the student's work,
// classify topics, and reply with a weak-topic summary. The paper is saved
// as paperType: "diagnostic" and is visible only to the parent + that
// student + admin (via standard ownership rules).

import { promises as fs, readFileSync } from "fs";
import path from "path";
import sgMail from "@sendgrid/mail";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { renderPdfToJpegs } from "@/lib/pdf-server";
import { maskBottomRightCorner } from "@/lib/watermark";

// Canonical syllabus topic lists. Diagnostic-flow topic tags MUST come
// from these — that's what the focused-practice picker matches against.
// Free-text labels would land tagged questions in 'Untagged' and the
// 'Assign focused practice' deep-link wouldn't find them.
function loadTopicFile(filename: string): string[] {
  try {
    return readFileSync(path.join(process.cwd(), "data", filename), "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
const MATH_TOPICS = loadTopicFile("math-topics.txt");
const SCIENCE_TOPICS = loadTopicFile("science-topics.txt");
const ENGLISH_TOPICS = loadTopicFile("english-topics.txt");

function topicListForSubject(subject: string): string[] {
  const s = subject.toLowerCase();
  if (s.includes("math")) return MATH_TOPICS;
  if (s.includes("sci")) return SCIENCE_TOPICS;
  if (s.includes("eng")) return ENGLISH_TOPICS;
  // No hint — give Gemini the union and let it pick.
  return [...MATH_TOPICS, ...SCIENCE_TOPICS, ...ENGLISH_TOPICS];
}

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
  marksAvailable: number;      // marks the question is worth (1 for MCQ, more for OEQ)
  marksAwarded: number;        // marks the student earned (0..marksAvailable)
  yStartPct: number;           // 0-100, top of the question region on the cropped page
  yEndPct: number;             // 0-100, bottom
};

// Per-page diagnosis output: the question array PLUS any cover-style
// totals the page advertised (printed paper total like "/50" or
// teacher-written running total like "31.5/50"). Taken as ground truth
// when present.
type PageDiagnosis = {
  questions: DiagnosedQuestion[];
  paperTotalMarks: number | null;     // printed total on the page, e.g. 50
  teacherAwardedMarks: number | null; // teacher's running/final score, e.g. 31.5
};

async function diagnosePage(jpeg: Buffer, subjectHint: string, levelHint: string | null): Promise<PageDiagnosis> {
  const ai = getAI();
  const allowedTopics = topicListForSubject(subjectHint);
  const prompt = `You are reviewing one page of a Singapore primary-school past paper photographed by a parent. The student has handwritten answers on the paper, AND there may already be red-ink marks from the school teacher.

CONTEXT:
- Subject (best guess from the page): ${subjectHint || "auto-detect"}
- Student level: ${levelHint ?? "unknown — primary school"}

TEACHER'S RED-INK MARKS (PRIORITY GROUND TRUTH — READ CAREFULLY):
Before assessing any answer, scan for the teacher's red-pen annotations. They are the authoritative score — your own judgement is the fallback used only when the teacher hasn't marked the question.

Look for ALL of these (red ink, often small, may be at the end of an answer line, in the margin, or above the answer):
- Red tick (✓) → full marks for that subpart
- Red cross (✗) → 0 marks for that subpart
- Half-mark indicators — TREAT ALL THE FOLLOWING AS 0.5 MARKS:
    * "✓½" or "½" or "1/2" or "0.5" written in red
    * A tick with a small ½ or ½ written next to it
    * A horizontal line through a tick (sometimes used for half)
    * "1/2" written above the answer
- Explicit numerics like "1/2", "1.5", "-0.5", "-1" → use exactly the awarded / deducted value the teacher wrote
- Margin comments — "how?", "explain more", "no working", "wrong unit", "incomplete", "not specific", "more detail" — even WITHOUT a half-mark symbol, these comments combined with a tick imply partial credit (typically half).

OEQ SECTIONS — CRITICAL:
OEQ questions often carry 2 marks across multiple lines or subparts (a)/(b)/(c). Teachers commonly:
- Tick part of an answer and put "½" or "1" next to it
- Mark each subpart separately — (a) might get a tick, (b) a half, (c) a cross
- Write the subpart total as "1½/2" or "0.5/1" at the END of the question

You MUST inspect every line of an OEQ answer for these per-line / per-subpart half marks. Past runs missed many half-mark deductions because the AI gave full marks based on its own rubric while the teacher had clearly written "½" against one of the subparts. Sum the per-subpart teacher marks if present, and put that in marksAwarded.

WHEN A TEACHER MARK IS PRESENT:
- "marksAwarded" must reflect the teacher's score, NOT your own.
- READ THE MARGIN COMMENT CAREFULLY and use it to write the feedback. The teacher's comment tells you WHY marks were lost. Translate it into a concrete, SPECIFIC explanation that names the actual missing element — pull the specific values, terms, or observations from the question stem / diagram / table / graph that the student should have referenced. A vague restatement of the teacher's comment is not enough.

  Examples:
    * Question shows a temperature graph going from 20°C to 80°C over 5 minutes. Student wrote "the metal got hotter". Teacher: "✓½" + "use data?" →
      feedback: "Teacher gave 0.5 marks. The student should have quoted the numbers from the graph — e.g. 'the temperature rose from 20°C to 80°C in 5 minutes'. The question asked for an explanation supported by the data."
    * Question shows a table with seedling heights of 5, 7, 9 cm over 3 weeks. Student wrote "the plants grew". Teacher: "✓½" + "use data" →
      feedback: "Teacher gave 0.5 marks. The student needed to reference the actual heights from the table (5 cm → 9 cm over 3 weeks) instead of just saying the plants grew."
    * Teacher: "✓½" + "how?" on "Why does ice melt in a warm room?" →
      feedback: "Teacher gave half marks. The student stated ice melts but didn't explain the mechanism — heat energy from the warm room is transferred to the ice, causing the particles to gain energy and change state."
    * Teacher: "✓½" + "incomplete" on a 2-mark question with two parts →
      feedback: "Teacher gave half marks. The student answered part one but missed part two — name the specific missing part by looking at the question stem."
    * Teacher: "✗" + "wrong unit" →
      feedback: "Teacher marked wrong because the student used the wrong unit. The expected unit (from the question / answer key) is X."
- For "what is a community?" with student "a group of organisms living together" and teacher "✓½" + "how?":
    feedback: "Teacher gave half marks. The answer is too vague — missing the keywords 'different populations' and 'habitat' that distinguish a community from a generic group."

The feedback should ALWAYS be specific enough that a parent reading it knows exactly what their child should have written. Generic comments like "didn't use data" are not useful — say WHICH data, by quoting from the question.

WHEN NO TEACHER MARK IS PRESENT:
- Mark the question yourself using the rubric in your standard primary-school marking pass.

TOPIC VOCABULARY (REQUIRED):
The "topic" field MUST be EXACTLY one of the strings below — copied verbatim, including capitalisation and punctuation. Do not invent new labels, do not abbreviate, do not paraphrase. If a question doesn't fit, pick the closest one. Strings outside this list will be rejected and the question will end up un-tagged.

${allowedTopics.map(t => `- ${t}`).join("\n")}

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
10. "marksAvailable": the marks the question is worth based on the printed paper (look for "[2]", "(2 marks)", etc near the question). Default 1 for MCQ, 2 for typical OEQ if not printed. Half-marks allowed (e.g. 0.5).
11. "marksAwarded": the marks the student actually earned (0..marksAvailable). Use partial marks for OEQ when only some of the required components are present. For MCQ, all-or-nothing (0 or marksAvailable).
12. "yStartPct" and "yEndPct": 0-100 vertical bounds of the question on the cropped image.

CRITICAL: Output EVERY question on the page, even compactly-laid-out ones. Long papers often have 4-8 questions per page. Do not skip questions just because they look similar to neighbours.

Skip cover pages, pure instruction pages, and any non-question content from the questions array (but DO read them for the totals fields below).

PAPER TOTALS (CRUCIAL — overrides per-question marks):
On a cover page, header, or final summary box, primary-school papers usually print a paper total like "Total: ___ / 50" and the teacher writes the awarded score in red ("31.5"). Look carefully on this page for either:
- "paperTotalMarks": the printed total marks for the WHOLE paper (e.g. 50). Null if not visible on this page.
- "teacherAwardedMarks": the teacher's handwritten total score for the WHOLE paper. Null if not visible.

CRITICAL — handwritten fractional marks: teachers commonly write half marks as "31 1/2", "31½", "31.5", or "31 ½ ". Treat ALL of these as 31.5 (THIRTY-ONE POINT FIVE), NOT as 36, 312, or any other concatenation. The "1/2" fraction is one symbol, not two digits. If you see a number followed by "1/2" or "½" or ".5" or "0.5", the awarded marks are <number> + 0.5. Be very careful with this — past runs misread "31 1/2" as "36".

Both fields apply to the WHOLE paper. If you spot them on any page, return the actual numbers — the server will use them as authoritative totals over our per-question sums. If unsure, return null rather than guessing.

OUTPUT FORMAT: a JSON OBJECT with three keys:
- "questions": JSON array of question records as described above
- "paperTotalMarks": number or null
- "teacherAwardedMarks": number or null

NO commentary.`;
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
    const raw = resp.text ?? "{}";
    const parsed = JSON.parse(raw) as { questions?: DiagnosedQuestion[]; paperTotalMarks?: number | null; teacherAwardedMarks?: number | null } | DiagnosedQuestion[];
    // Tolerate the legacy plain-array shape in case Gemini drops the wrapper object.
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.questions) ? parsed.questions : []);
    const paperTotalMarks = (!Array.isArray(parsed) && typeof parsed.paperTotalMarks === "number" && parsed.paperTotalMarks > 0) ? parsed.paperTotalMarks : null;
    const teacherAwardedMarks = (!Array.isArray(parsed) && typeof parsed.teacherAwardedMarks === "number" && parsed.teacherAwardedMarks >= 0) ? parsed.teacherAwardedMarks : null;
    const questions = arr.map(q => {
      const marksAvailable = Math.max(0, Number(q.marksAvailable ?? 1));
      const isCorrect = Boolean(q.isCorrect);
      const marksAwardedRaw = Number(q.marksAwarded ?? (isCorrect ? marksAvailable : 0));
      const rawTopic = String(q.topic ?? "").trim();
      return {
        questionNum: String(q.questionNum ?? "?"),
        stem: String(q.stem ?? ""),
        options: Array.isArray(q.options) ? q.options.map(o => String(o)) : [],
        expectedAnswer: String(q.expectedAnswer ?? ""),
        studentAnswer: String(q.studentAnswer ?? ""),
        isCorrect,
        isBlank: Boolean(q.isBlank),
        feedback: String(q.feedback ?? ""),
        topic: snapToCanonicalTopic(rawTopic, allowedTopics),
        marksAvailable,
        marksAwarded: clamp(marksAwardedRaw, 0, marksAvailable),
        yStartPct: clamp(Number(q.yStartPct ?? 0), 0, 100),
        yEndPct: clamp(Number(q.yEndPct ?? 100), 0, 100),
      };
    });
    return { questions, paperTotalMarks, teacherAwardedMarks };
  } catch (err) {
    console.error("[diagnose] page analysis failed:", err);
    return { questions: [], paperTotalMarks: null, teacherAwardedMarks: null };
  }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// Dedicated, narrow Gemini call to read the teacher's running total on
// a single page. Used as a second-source cross-check against the
// per-page detector — fractional marks ("31 1/2", "31½") trip up the
// combined extract+mark+classify prompt, so we ask in isolation.
async function readCoverTotal(jpeg: Buffer): Promise<{ paperTotalMarks: number | null; teacherAwardedMarks: number | null }> {
  const ai = getAI();
  const prompt = `Look at this scanned exam page. Is there a teacher's running total or final mark visible — typically in red ink, in a corner, header, or summary box? It looks like a number-over-number such as "31 1/2 / 50", "31.5/50", "42/60", or just a circled red number near the printed paper total.

CRITICAL — fractional marks: teachers OFTEN write half marks as "31 1/2", "31 ½", or "31.5". These are all THIRTY-ONE POINT FIVE (31.5), not 36, not 312. The "1/2" fraction is a single symbol. Read very carefully.

Return a JSON object with exactly two keys:
- "paperTotalMarks": the printed paper total (the number after the slash, e.g. 50). Null if no total is visible.
- "teacherAwardedMarks": the teacher's handwritten score. Half marks supported (e.g. 31.5). Null if no teacher total is visible.

If the page has no totals at all (most pages won't), return {"paperTotalMarks": null, "teacherAwardedMarks": null}.

NO commentary.`;
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
    const raw = resp.text ?? "{}";
    const parsed = JSON.parse(raw) as { paperTotalMarks?: number | null; teacherAwardedMarks?: number | null };
    const paperTotalMarks = typeof parsed.paperTotalMarks === "number" && parsed.paperTotalMarks > 0 ? parsed.paperTotalMarks : null;
    const teacherAwardedMarks = typeof parsed.teacherAwardedMarks === "number" && parsed.teacherAwardedMarks >= 0 ? parsed.teacherAwardedMarks : null;
    return { paperTotalMarks, teacherAwardedMarks };
  } catch {
    return { paperTotalMarks: null, teacherAwardedMarks: null };
  }
}

// Map a free-text topic from Gemini onto the canonical syllabus list.
// Tries exact match (case-insensitive) first, then a token-overlap
// score so 'Fractions and Decimals' maps to 'Fractions' instead of
// 'Untagged'. Falls back to 'Untagged' if no token overlaps at all.
function snapToCanonicalTopic(raw: string, allowed: string[]): string {
  if (!raw) return "Untagged";
  const norm = raw.toLowerCase();
  for (const t of allowed) {
    if (t.toLowerCase() === norm) return t;
  }
  const rawTokens = new Set(norm.split(/[^a-z0-9]+/).filter(t => t.length >= 4));
  let best: { topic: string; score: number } | null = null;
  for (const t of allowed) {
    const tokens = t.toLowerCase().split(/[^a-z0-9]+/).filter(s => s.length >= 4);
    let overlap = 0;
    for (const tok of tokens) if (rawTokens.has(tok)) overlap++;
    if (overlap > 0 && (!best || overlap > best.score)) best = { topic: t, score: overlap };
  }
  return best?.topic ?? "Untagged";
}

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
  // Read every Blob into memory now: SendGrid retries inbound parse if
  // we don't return 200 quickly, and the form's blobs are tied to the
  // request lifecycle. Snapshotting them now lets us fire the heavy
  // analysis as a background promise and acknowledge fast.
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

  // Fire-and-forget: SendGrid will retry if we hold the response open
  // longer than ~30s and a 26-page Gemini run takes ~80s. Resolve the
  // webhook immediately with a 200, run the diagnosis in the
  // background. Any unhandled error inside is logged so the operator
  // can see what went wrong without crashing the process.
  runDiagnosisInBackground(attachments, parent, student, subjectStr, fromEmail).catch(err => {
    console.error("[diagnose] background run failed:", err);
  });

  return Response.json({
    ok: true,
    queued: true,
    student: student.name,
    attachmentCount: attachments.length,
  });
}

async function runDiagnosisInBackground(
  attachments: DiagnoseAttachment[],
  parent: DiagnoseParent,
  student: { id: string; name: string; level: number | null },
  subjectStr: string,
  fromEmail: string,
): Promise<void> {
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
    console.warn("[diagnose] no usable pages from attachments");
    return;
  }

  // Subject hint comes from the email subject — parent may write
  // "Math diagnostic" / "P5 science" / etc. Pure heuristic.
  const subjectHint = subjectStr.toLowerCase().includes("sci") ? "Science"
    : subjectStr.toLowerCase().includes("eng") ? "English"
    : subjectStr.toLowerCase().includes("math") ? "Mathematics"
    : "";
  const levelHint = student.level ? `Primary ${student.level}` : null;

  // Create the paper FIRST with markingStatus='in_progress' so it
  // appears on the dashboard as "Marking…" while the Gemini analysis
  // runs (~60-90s). The parent sees it immediately and clicks are
  // blocked until status flips to 'complete'. We update the score +
  // questions in a second pass after the analysis finishes.
  const placeholderPaper = await prisma.examPaper.create({
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
      markingStatus: "in_progress",
      metadata: { source: "diagnose-email", subjectHintFromEmail: subjectStr } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const paperId = placeholderPaper.id;

  // Save the page JPGs straight away — they're already in memory and
  // the review UI renders them via /api/exam/<id>/submission, so the
  // parent (admin) can scroll through the scans even while marking.
  const subDir = path.join(SUBMISSIONS_DIR, paperId);
  await fs.mkdir(subDir, { recursive: true });
  for (let i = 0; i < pageJpegs.length; i++) {
    await fs.writeFile(path.join(subDir, `page_${i}.jpg`), pageJpegs[i]);
  }
  console.log(`[diagnose] paper=${paperId} created in_progress with ${pageJpegs.length} page JPGs saved`);

  // Run Gemini diagnosis on every page in parallel. The first and last
  // few pages also get a dedicated cover-scan call (focused only on
  // teacher's running total) to cross-check the totals — handwritten
  // half marks like '31 1/2' trip up the combined prompt.
  console.log(`[diagnose] analysing ${pageJpegs.length} pages for student=${student.id} (${student.name})`);
  const t0 = Date.now();
  const coverScanIndices = new Set<number>([0, 1, pageJpegs.length - 2, pageJpegs.length - 1].filter(i => i >= 0 && i < pageJpegs.length));
  const [perPage, coverScans] = await Promise.all([
    Promise.all(pageJpegs.map(buf => diagnosePage(buf, subjectHint, levelHint))),
    Promise.all(pageJpegs.map((buf, i) => coverScanIndices.has(i) ? readCoverTotal(buf) : Promise.resolve({ paperTotalMarks: null as number | null, teacherAwardedMarks: null as number | null }))),
  ]);
  console.log(`[diagnose] page analysis done in ${Date.now() - t0}ms`);
  const flat = perPage.flatMap((page, pageIdx) => page.questions.map(q => ({ ...q, pageIndex: pageIdx })));

  // Authoritative totals from BOTH passes (per-page detector + dedicated
  // cover-scan). For paper-total-marks (a printed number, easy to read)
  // take the modal/highest value. For teacher-awarded (handwritten,
  // can include halves) prefer the cover-scan's value if it disagrees
  // with the per-page sum, and pick the SMALLEST non-zero value across
  // pages — duplicate teacher totals often appear on cover + final
  // page; a runaway larger value is more likely to be a misread.
  const allPaperTotals = [
    ...perPage.map(p => p.paperTotalMarks ?? 0),
    ...coverScans.map(c => c.paperTotalMarks ?? 0),
  ].filter(n => n > 0);
  const allTeacherAwarded = [
    ...coverScans.map(c => c.teacherAwardedMarks ?? null),
    ...perPage.map(p => p.teacherAwardedMarks ?? null),
  ].filter((n): n is number => typeof n === "number");
  const coverPaperTotal = allPaperTotals.length > 0 ? Math.max(...allPaperTotals) : 0;
  const coverTeacherAwarded = allTeacherAwarded.length > 0 ? Math.min(...allTeacherAwarded) : 0;
  if (coverPaperTotal > 0 || coverTeacherAwarded > 0) {
    console.log(`[diagnose] cover-page totals: paperTotalMarks=${coverPaperTotal || "?"} teacherAwarded=${coverTeacherAwarded || "?"} (raw scan=[${allTeacherAwarded.join(",")}], inline=[${perPage.map(p => p.teacherAwardedMarks ?? "_").join(",")}])`);
  }
  // Verbose breakdown so the parent can sanity-check the AI's work.
  // Logs: total questions, total marks, per-page question counts, the
  // exact list of wrong/blank questions, and the topics that lost marks.
  {
    const totalAvail = flat.reduce((s, q) => s + q.marksAvailable, 0);
    const totalAwarded = flat.reduce((s, q) => s + q.marksAwarded, 0);
    const perPageCounts = perPage.map((p, i) => `p${i}=${p.questions.length}`).join(" ");
    const wrong = flat.filter(q => !q.isCorrect);
    const wrongDesc = wrong.map(q => `Q${q.questionNum}(${q.topic}, ${q.marksAwarded}/${q.marksAvailable}, p${q.pageIndex})`).join(" | ");
    const lossByTopic = new Map<string, number>();
    for (const q of wrong) {
      lossByTopic.set(q.topic, (lossByTopic.get(q.topic) ?? 0) + (q.marksAvailable - q.marksAwarded));
    }
    const topicLossDesc = [...lossByTopic.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, l]) => `${t}=-${l}`)
      .join(" | ");
    console.log(`[diagnose] ${flat.length} questions across ${pageJpegs.length} pages (${perPageCounts})`);
    console.log(`[diagnose] score: ${totalAwarded} / ${totalAvail}`);
    console.log(`[diagnose] wrong/partial (${wrong.length}): ${wrongDesc || "none"}`);
    console.log(`[diagnose] marks lost by topic: ${topicLossDesc || "none"}`);
  }
  if (flat.length === 0) {
    await maybeReply(fromEmail, "Diagnose: no questions detected", "We couldn't find any questions in the photos you sent. Try a clearer photo or PDF, with one full page per image.").catch(() => {});
    return;
  }

  // Backfill the placeholder paper with the analysis results and flip
  // markingStatus to 'complete'. instantFeedback stays true so the
  // student sees the score immediately — no parent release needed.
  await prisma.$transaction([
    prisma.examQuestion.createMany({
      data: flat.map((q, idx) => ({
        examPaperId: paperId,
        questionNum: q.questionNum,
        imageData: "",
        answer: q.expectedAnswer || null,
        pageIndex: q.pageIndex,
        orderIndex: idx,
        yStartPct: q.yStartPct,
        yEndPct: q.yEndPct,
        marksAvailable: q.marksAvailable,
        marksAwarded: q.marksAwarded,
        studentAnswer: q.studentAnswer || null,
        markingNotes: q.feedback || null,
        syllabusTopic: q.topic || null,
        transcribedStem: q.stem || null,
        transcribedOptions: (q.options ?? []).length > 0 ? ((q.options ?? []) as Prisma.InputJsonValue) : Prisma.JsonNull,
      })),
    }),
    prisma.examPaper.update({
      where: { id: paperId },
      data: {
        markingStatus: "complete",
        // Prefer cover-page totals when the AI spotted them — that's
        // what the school treats as ground truth.
        score: coverTeacherAwarded > 0 ? coverTeacherAwarded : flat.reduce((s, q) => s + q.marksAwarded, 0),
        totalMarks: String(coverPaperTotal > 0 ? coverPaperTotal : flat.reduce((s, q) => s + q.marksAvailable, 0)),
      },
    }),
  ]);
  const paper = { id: paperId };
  // Page JPGs were saved to disk at placeholder creation, so the
  // submission render works straight away — nothing more to do here.

  // Group by topic. Weak topics = the top 3 by absolute wrong count
  // (tie-break: lower correct percentage first). Strong topics = any
  // topic with 100% correct on 2+ questions. The "absolute mistakes"
  // approach gives the parent something actionable even when the
  // student is mostly strong and wrong answers are spread thinly —
  // a strict <50% threshold tends to flag nothing on a 26-page paper.
  const byTopic = new Map<string, { earned: number; available: number; total: number; right: number }>();
  for (const q of flat) {
    const t = q.topic;
    const cur = byTopic.get(t) ?? { earned: 0, available: 0, total: 0, right: 0 };
    cur.earned += q.marksAwarded;
    cur.available += q.marksAvailable;
    cur.total++;
    if (q.isCorrect) cur.right++;
    byTopic.set(t, cur);
  }
  const allTopics = Array.from(byTopic.entries()).map(([topic, s]) => ({
    topic,
    earned: s.earned,
    available: s.available,
    lost: s.available - s.earned,
    right: s.right,
    total: s.total,
  }));
  const weak = allTopics
    .filter(t => t.lost > 0)
    .sort((a, b) => {
      if (b.lost !== a.lost) return b.lost - a.lost;
      return (a.earned / a.available) - (b.earned / b.available);
    })
    .slice(0, 3);
  const strong = allTopics
    .filter(t => t.total >= 2 && t.lost === 0)
    .slice(0, 5);

  const aiTotalEarned = flat.reduce((s, q) => s + q.marksAwarded, 0);
  const aiTotalAvailable = flat.reduce((s, q) => s + q.marksAvailable, 0);
  const totalEarned = coverTeacherAwarded > 0 ? coverTeacherAwarded : aiTotalEarned;
  const totalAvailable = coverPaperTotal > 0 ? coverPaperTotal : aiTotalAvailable;
  if (coverTeacherAwarded > 0 || coverPaperTotal > 0) {
    console.log(`[diagnose] using cover totals: ${totalEarned}/${totalAvailable} (per-question sums were ${aiTotalEarned}/${aiTotalAvailable})`);
  }
  await maybeReply(
    fromEmail,
    `Diagnose: ${student.name} — ${formatNum(totalEarned)}/${formatNum(totalAvailable)} marks`,
    buildSummaryHtml(student.name, totalAvailable, totalEarned, weak, strong, parent.id, paper.id),
    { html: true },
  ).catch((err) => console.error("[diagnose] reply email failed:", err));

  console.log(`[diagnose] paper=${paper.id} student=${student.id} marks=${totalEarned}/${totalAvailable} weak=[${weak.map(w => `${w.topic}(-${w.lost})`).join(", ")}]`);
}

function buildSummaryHtml(
  studentName: string,
  totalAvailable: number,
  totalEarned: number,
  weak: { topic: string; earned: number; available: number; lost: number }[],
  strong: { topic: string; earned: number; available: number; total: number }[],
  parentId: string,
  paperId: string,
): string {
  const dashboardUrl = `${APP_URL}/home/${parentId}?focusedSuggest=${encodeURIComponent(weak.map(w => w.topic).join(","))}`;
  const reviewUrl = `${APP_URL}/exam/${paperId}/review?userId=${parentId}`;
  const weakList = weak.length === 0
    ? "<p>No marks lost — every question was correct. Nice work!</p>"
    : `<ul>${weak.map(w => `<li><strong>${escapeHtml(w.topic)}</strong> — lost ${formatNum(w.lost)} mark${w.lost === 1 ? "" : "s"} (${formatNum(w.earned)}/${formatNum(w.available)})</li>`).join("")}</ul>`;
  const strongList = strong.length === 0 ? "" : `<p><em>Strengths:</em> ${strong.map(s => escapeHtml(s.topic)).join(", ")}</p>`;
  return `<!doctype html><html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; color: #0b1c30;">
<h2 style="color: #001e40;">Diagnostic results for ${escapeHtml(studentName)}</h2>
<p>${formatNum(totalEarned)} of ${formatNum(totalAvailable)} marks.</p>
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

function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
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
  // Disable SendGrid's click + open tracking. Click tracking rewrites
  // every link through a tracking subdomain (urlNNNN.markforyou.com)
  // that we haven't set up CNAMEs for, so the parent's 'See marked
  // paper' / 'Assign focused practice' links 404 with NXDOMAIN.
  const trackingSettings = {
    clickTracking: { enable: false, enableText: false },
    openTracking: { enable: false },
    subscriptionTracking: { enable: false },
  };
  const msg = opts.html
    ? { to, from: { email: FROM_ADDRESS, name: FROM_NAME }, subject, html: body, trackingSettings }
    : { to, from: { email: FROM_ADDRESS, name: FROM_NAME }, subject, text: body, trackingSettings };
  try {
    const [resp] = await sgMail.send(msg);
    console.log(`[diagnose] reply email sent to=${to} from=${FROM_ADDRESS} status=${resp.statusCode} messageId=${resp.headers?.["x-message-id"] ?? "n/a"}`);
  } catch (err) {
    // SendGrid wraps the API error in err.response.body — print that
    // in full so we can see the actual reason (unverified sender,
    // suppression list hit, malformed from address, etc).
    const errAny = err as { response?: { body?: unknown; statusCode?: number } } & Error;
    console.error(
      `[diagnose] sgMail.send failed to=${to} from=${FROM_ADDRESS} status=${errAny.response?.statusCode ?? "?"} body=${JSON.stringify(errAny.response?.body)} msg=${errAny.message}`,
    );
    throw err;
  }
}
