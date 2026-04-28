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
OEQ questions often carry 2 marks across multiple lines or subparts (a)/(b)/(c). Teachers in Singapore primary schools mark them by writing the AWARDED score (NOT a deduction) next to each subpart in red ink. Watch for ALL of these formats:
- A bare red number "1.5" / "0.5" / "1" / "2" written at the end of an answer line or in the margin → that IS the marksAwarded for that subpart. NOT a deduction. So a "0.5" next to a 1-mark subpart means marksAwarded=0.5, not marksAwarded=0.5 less.
- Red fraction "1½" / "½" / "1 1/2" → 1.5 / 0.5 / 1.5 awarded.
- "1.5/2" or "1½/2" written at the END of a 2-mark question → marksAwarded for the WHOLE question is 1.5.
- A tick next to part (a), a cross next to (b), and "1/2" written at the end → the whole question is 1 out of 2.

You MUST inspect every line of an OEQ answer for these per-line / per-subpart numeric scores. Past runs missed many half-mark deductions because the AI gave full marks based on its own rubric while the teacher had clearly written "0.5" or "1.5" next to one of the subparts. When in doubt: a small red number near an OEQ answer is the AWARDED MARKS — read it and use it.

Sum the per-subpart teacher marks if present, and put the total in marksAwarded. If a final per-question score like "1.5/2" appears, that overrides per-subpart sums (the teacher already did the maths).

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
        stem: stripLatex(String(q.stem ?? "")),
        options: Array.isArray(q.options) ? q.options.map(o => stripLatex(String(o))) : [],
        expectedAnswer: stripLatex(String(q.expectedAnswer ?? "")),
        studentAnswer: stripLatex(String(q.studentAnswer ?? "")),
        isCorrect,
        isBlank: Boolean(q.isBlank),
        feedback: stripLatex(String(q.feedback ?? "")),
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

// Convert any LaTeX math fragments that slip through into plain
// Unicode so the review UI (which doesn't run a math renderer) shows
// a readable string instead of literal '$\\angle DHG = 48^\\circ$'.
// Best-effort — covers the patterns Gemini tends to emit on math /
// geometry questions. Anything we don't match is left alone.
function stripLatex(s: string | null | undefined): string {
  if (!s) return "";
  let out = s;
  // Greek letters
  const greek: Record<string, string> = {
    "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ",
    "\\theta": "θ", "\\pi": "π", "\\sigma": "σ", "\\omega": "ω",
    "\\Delta": "Δ", "\\Sigma": "Σ", "\\Omega": "Ω",
  };
  for (const [k, v] of Object.entries(greek)) {
    out = out.split(k).join(v);
  }
  // Symbols
  out = out
    .replace(/\\angle\s*/g, "∠")
    .replace(/\\triangle\s*/g, "△")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\pm/g, "±")
    .replace(/\\leq/g, "≤")
    .replace(/\\geq/g, "≥")
    .replace(/\\neq/g, "≠")
    .replace(/\\approx/g, "≈")
    .replace(/\\cdot/g, "·")
    .replace(/\\to/g, "→")
    .replace(/\\rightarrow/g, "→");
  // Degree: ^\circ or ^{\circ}
  out = out.replace(/\^\s*\{?\s*\\circ\s*\}?/g, "°");
  // Fractions \frac{a}{b} → a/b
  out = out.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${a}/${b}`);
  // Superscripts ^2 / ^{2} → ², where we have a Unicode equivalent.
  const supMap: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  out = out.replace(/\^\s*\{([0-9])\}/g, (_, d) => supMap[d as string] ?? `^${d}`);
  out = out.replace(/\^\s*([0-9])/g, (_, d) => supMap[d as string] ?? `^${d}`);
  // Strip math delimiters $...$ and $$...$$
  out = out.replace(/\$\$([^$]*)\$\$/g, "$1").replace(/\$([^$]*)\$/g, "$1");
  // Strip remaining \word{} commands (best-effort) — keep the inner content if any
  out = out.replace(/\\([a-zA-Z]+)\s*\{([^{}]*)\}/g, "$2");
  out = out.replace(/\\([a-zA-Z]+)/g, "");
  // Tidy up double spaces left by replacements
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

// Clamp the headline score at the paper's total available marks. Logs
// a warning if clamping was necessary so we can spot whatever inflated
// the per-question sum (usually duplicate-question extraction).
function clampScoreLogged(awarded: number, available: number, paperId: string): number {
  if (available <= 0) return awarded;
  if (awarded > available) {
    console.warn(`[diagnose] paper=${paperId} score ${awarded} > total available ${available} — clamping to ${available}. Likely a duplicate-question extraction.`);
    return available;
  }
  return Math.max(0, awarded);
}

// Re-check an MCQ answer specifically for "1" (a thin vertical stroke
// that combined extract+mark passes routinely miss). Runs after the
// per-page diagnosis on every MCQ whose detected studentAnswer isn't
// already "1". Returns true if the model is confident the student
// wrote a 1 in the answer area.
async function detectMcqAnswerOne(regionJpeg: Buffer, qLabel: string): Promise<boolean> {
  const ai = getAI();
  const prompt = `Look very carefully at this cropped exam question region. The student wrote a single MCQ answer somewhere — a digit between 1 and 4 (or 1-5).

QUESTION: did the student write a "1" as their answer?

The number "1" handwritten by primary-school students is often very thin and easy to miss — usually just one short vertical stroke, sometimes with a tiny serif at top or bottom. It can look like a slash, a comma's stem, or a bare line. ANY plausible vertical stroke in the answer space counts as "1" for this question. If you see ANY mark in the answer area that could be a 1, say yes.

Reply with JSON only: {"isOne": true} or {"isOne": false}.

If the student clearly wrote a different digit (2, 3, 4, 5) and there is no separate "1" anywhere, return false.`;
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: regionJpeg.toString("base64") } },
        ],
      }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const raw = resp.text ?? "{}";
    const parsed = JSON.parse(raw) as { isOne?: boolean };
    return Boolean(parsed.isOne);
  } catch (err) {
    console.error(`[diagnose] detectMcqAnswerOne ${qLabel} failed:`, err);
    return false;
  }
}

function isMcqQuestion(q: { options?: string[]; expectedAnswer?: string }): boolean {
  // Has options array and the expected answer reads as a single
  // letter/digit, or has 2+ options. Either signal is enough.
  if (Array.isArray(q.options) && q.options.length >= 2) return true;
  const a = (q.expectedAnswer ?? "").trim();
  return /^[A-D1-4]$/i.test(a);
}

// Geometry-focused recheck. Math geometry questions require multi-step
// formal reasoning (area / perimeter / angle properties / construction)
// that the per-page combined prompt rushes through and gets wrong.
// Re-mark with the most advanced model available — defaults to
// gemini-3-pro-preview (override via GEOMETRY_MODEL env if Railway's
// API key doesn't have access yet).
const GEOMETRY_MODEL = process.env.GEOMETRY_MODEL ?? "gemini-3-pro-preview";

async function remarkGeometryQuestion(
  regionJpeg: Buffer,
  q: { questionNum: string; stem: string; options: string[]; expectedAnswer: string; studentAnswer: string; marksAvailable: number },
): Promise<{ marksAwarded: number; isCorrect: boolean; expectedAnswer: string; studentAnswer: string; feedback: string } | null> {
  const ai = getAI();
  const isMcq = q.options.length >= 2;
  const prompt = `You are a meticulous primary-school MATHEMATICS tutor specialising in GEOMETRY. The attached image is the cropped region for ONE geometry question on a student's scanned exam paper.

QUESTION CONTEXT:
- Question number: ${q.questionNum}
- Question stem (transcribed): ${q.stem}
- ${isMcq ? `MCQ options: ${q.options.join(" | ")}` : "Open-ended question"}
- First-pass expected answer (may be wrong, please verify): ${q.expectedAnswer || "(none)"}
- First-pass student answer (may be misread, please verify by looking at the image): ${q.studentAnswer || "(blank)"}
- Marks available: ${q.marksAvailable}

INSTRUCTIONS:
1. Read the diagram carefully — note all labelled lengths, angles, shape types, and any markings (right-angle squares, parallel arrows, equal-tick marks).
2. Identify the geometric concept being tested (area, perimeter, angle sum, similarity, transformations, etc.) and apply the appropriate formula or property step-by-step.
3. Compute the correct answer formally. Show your reasoning to yourself; only the final result is returned.
4. Re-read the student's handwritten answer in the image — correct any misreads from the first pass.
5. Compare student's answer to your derived correct answer. Allow for unit-equivalent forms (e.g. "5cm" vs "5 cm") but be strict about value.
6. Award marks: full marks if correct; partial (typically half) if working is shown but final answer is wrong; 0 if blank or fundamentally wrong with no salvageable steps.

FORMATTING (CRITICAL): the feedback text will be displayed verbatim to a parent in plain HTML — no math renderer is available. Do NOT use LaTeX. NEVER write '$...$', '\\angle', '\\circ', '\\frac{...}{...}', '\\times', '\\div', or any backslash-command. Use plain Unicode math instead:
- '∠ABC' (not '\\angle ABC')
- '48°' (not '48^\\circ' or '$48^\\circ$')
- '×' / '÷' (not '\\times' / '\\div')
- '½' '¼' '¾' or 'a/b' (not '\\frac{a}{b}')
- '²' '³' for squares / cubes (not '^2' / '^{3}')
- 'π' (not '\\pi')

OUTPUT (JSON only):
{
  "expectedAnswer": "<your derived correct answer, plain text + unicode math, NO LaTeX>",
  "studentAnswer": "<what the student actually wrote, possibly corrected from the first pass>",
  "isCorrect": <boolean>,
  "marksAwarded": <number 0 .. ${q.marksAvailable}>,
  "feedback": "<1-2 sentences explaining what went wrong, naming the specific geometric property or formula. Plain text only. 'Correct' if isCorrect.>"
}

NO commentary outside the JSON.`;
  try {
    const resp = await ai.models.generateContent({
      model: GEOMETRY_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: regionJpeg.toString("base64") } },
        ],
      }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const raw = resp.text ?? "{}";
    const parsed = JSON.parse(raw) as { expectedAnswer?: string; studentAnswer?: string; isCorrect?: boolean; marksAwarded?: number; feedback?: string };
    return {
      marksAwarded: clamp(Number(parsed.marksAwarded ?? 0), 0, q.marksAvailable),
      isCorrect: Boolean(parsed.isCorrect),
      expectedAnswer: stripLatex(parsed.expectedAnswer ?? q.expectedAnswer),
      studentAnswer: stripLatex(parsed.studentAnswer ?? q.studentAnswer),
      feedback: stripLatex(parsed.feedback ?? ""),
    };
  } catch (err) {
    console.error(`[diagnose] geometry recheck Q${q.questionNum} failed (model=${GEOMETRY_MODEL}):`, err);
    return null;
  }
}


// Dedicated, narrow Gemini call to read the teacher's running total on
// a single page. Used as a second-source cross-check against the
// per-page detector — fractional marks ("31 1/2", "31½") trip up the
// combined extract+mark+classify prompt, so we ask in isolation.
async function readCoverTotal(jpeg: Buffer, pageLabel: string): Promise<{ paperTotalMarks: number | null; teacherAwardedMarks: number | null; rawDescription: string }> {
  const ai = getAI();
  const prompt = `Look at this scanned exam page for ANY teacher-written marks in RED INK (red pen / red marker). They could be:
A. A SINGLE TOTAL: "31 1/2 / 50", "31.5/50", "42/60", a circled red number near a printed "/50".
B. SECTION TOTALS: e.g. "Section A: 24/28" / "Section B: 7.5/22" written down a column. SUM these for teacherAwardedMarks.
C. PER-QUESTION RED NUMBERS in the margin: e.g. "1", "0.5", "2", "1.5" written next to each question number. SUM all of them.

Whatever red numbers you can see on this page, ADD them up and return the sum as teacherAwardedMarks.

CRITICAL — handwritten fractional marks (READ THESE VERY CAREFULLY):
- "31 1/2" = 31.5. The "1/2" is a single fraction symbol, NOT digits 1 and 2.
- "31 ½" = 31.5
- "31.5" = 31.5
- A digit immediately followed by "1/2" or "½" or ".5" = digit + 0.5
- NEVER concatenate the fraction's "2" or "5" onto the leading digit. "31 1/2" is THIRTY-ONE-POINT-FIVE, not 312, 36, or 35.

Look in red ink first. The teacher's handwriting is what we want — not the printed denominator. If the only red ink you see is a tick/cross with no number, that's NOT a total — return null.

Return a JSON object with three keys:
- "paperTotalMarks": the printed paper total (the number after the slash, e.g. 50). Null if no total is visible.
- "teacherAwardedMarks": the SUM of all red-ink numeric scores you found on this page. If you found section totals A=24, B=7.5, return 31.5. If you found a single grand total "31½", return 31.5. If you only found per-question marks, sum them. Null if no red-ink scores are visible at all.
- "description": describe EVERY red-ink number / total you saw on this page and where, e.g. "Section A box shows '24/28' in red, Section B box shows '7.5/22' in red — sum is 31.5/50" or "Per-question marks in the margin: Q1=2, Q2=1.5, Q3=0... sum=12.5" or "No red ink anywhere on this page". Be exhaustive — list every red number. Up to 80 words.

NO commentary outside the JSON.`;
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
    const parsed = JSON.parse(raw) as { paperTotalMarks?: number | null; teacherAwardedMarks?: number | null; description?: string };
    const paperTotalMarks = typeof parsed.paperTotalMarks === "number" && parsed.paperTotalMarks > 0 ? parsed.paperTotalMarks : null;
    const teacherAwardedMarks = typeof parsed.teacherAwardedMarks === "number" && parsed.teacherAwardedMarks >= 0 ? parsed.teacherAwardedMarks : null;
    const rawDescription = String(parsed.description ?? "").slice(0, 200);
    console.log(`[diagnose] cover-scan ${pageLabel}: paperTotal=${paperTotalMarks ?? "_"} teacherAwarded=${teacherAwardedMarks ?? "_"} | "${rawDescription}"`);
    return { paperTotalMarks, teacherAwardedMarks, rawDescription };
  } catch (err) {
    console.error(`[diagnose] cover-scan ${pageLabel} failed:`, err);
    return { paperTotalMarks: null, teacherAwardedMarks: null, rawDescription: "" };
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
  // Subject-line student-name match: parent might write "Diagnose for
  // Mark Lim" or "Mark Lim's paper". Pick the linked student whose
  // FULL NAME appears in the subject — preferring the longest match
  // so "Mark Lim" wins over a sibling just called "Mark".
  const lower = subjectHintFromMail.toLowerCase();
  const matches = links
    .filter(l => l.student.name && lower.includes(l.student.name.toLowerCase()))
    .sort((a, b) => (b.student.name?.length ?? 0) - (a.student.name?.length ?? 0));
  if (matches.length > 0) return matches[0].student;
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
    Promise.all(pageJpegs.map((buf, i) => coverScanIndices.has(i)
      ? readCoverTotal(buf, `p${i}`)
      : Promise.resolve({ paperTotalMarks: null as number | null, teacherAwardedMarks: null as number | null, rawDescription: "" }))),
  ]);
  console.log(`[diagnose] page analysis done in ${Date.now() - t0}ms`);
  const rawFlat = perPage.flatMap((page, pageIdx) => page.questions.map(q => ({ ...q, pageIndex: pageIdx })));

  // Deduplicate by questionNum. Multi-page questions (math OEQ that
  // overflows to a second page, or a continued comprehension passage)
  // get extracted on every page Gemini sees them, and we'd sum the
  // marks twice. Keep the FIRST appearance — that's where the question
  // stem actually starts and where the student typically writes the
  // beginning of their answer.
  const seenQNum = new Set<string>();
  const dupSkips: string[] = [];
  const flat = rawFlat.filter(q => {
    const key = q.questionNum.trim().toLowerCase();
    if (!key || key === "?") return true; // unidentified, can't dedupe — keep
    if (seenQNum.has(key)) {
      dupSkips.push(`Q${q.questionNum}@p${q.pageIndex}`);
      return false;
    }
    seenQNum.add(key);
    return true;
  });
  if (dupSkips.length > 0) {
    console.log(`[diagnose] deduped ${dupSkips.length} duplicate question(s): ${dupSkips.join(", ")}`);
  }

  // Second-pass MCQ "1" detection. Every MCQ where the model didn't
  // already pick "1" gets a focused isolated re-check, because thin
  // vertical "1"s are routinely missed in the first pass. Runs in
  // parallel; cost is ~one Gemini-flash call per non-"1" MCQ.
  const mcqRecheckCandidates = flat.filter(q => isMcqQuestion(q) && (q.studentAnswer ?? "").trim() !== "1");
  if (mcqRecheckCandidates.length > 0) {
    console.log(`[diagnose] MCQ-1 recheck: ${mcqRecheckCandidates.length} candidates`);
    const recheck = await Promise.all(mcqRecheckCandidates.map(async q => {
      const jpg = pageJpegs[q.pageIndex];
      if (!jpg) return { q, isOne: false };
      try {
        const meta = await sharp(jpg).metadata();
        const W = meta.width ?? 0;
        const H = meta.height ?? 0;
        if (!W || !H) return { q, isOne: false };
        const top = Math.max(0, Math.floor(H * (q.yStartPct ?? 0) / 100));
        const bot = Math.min(H, Math.ceil(H * (q.yEndPct ?? 100) / 100));
        const h = Math.max(1, bot - top);
        const region = await sharp(jpg).extract({ left: 0, top, width: W, height: h }).jpeg({ quality: 88 }).toBuffer();
        const isOne = await detectMcqAnswerOne(region, `Q${q.questionNum}`);
        return { q, isOne };
      } catch (err) {
        console.error(`[diagnose] MCQ-1 recheck Q${q.questionNum} crop failed:`, err);
        return { q, isOne: false };
      }
    }));
    let overrides = 0;
    for (const r of recheck) {
      if (r.isOne) {
        r.q.studentAnswer = "1";
        const expected = (r.q.expectedAnswer ?? "").trim();
        const isCorrectNow = expected === "1";
        r.q.isCorrect = isCorrectNow;
        r.q.isBlank = false;
        r.q.marksAwarded = isCorrectNow ? r.q.marksAvailable : 0;
        overrides++;
      }
    }
    if (overrides > 0) console.log(`[diagnose] MCQ-1 recheck: overrode ${overrides} answers to "1"`);
  }

  // Geometry recheck. Math geometry questions get re-marked with the
  // most advanced model — primary-school geometry needs multi-step
  // formal reasoning the lighter pass tends to short-cut. The topic
  // tag is constrained to the math syllabus list, so 'Geometry' here
  // already implies a math question.
  const geomCandidates = flat.filter(q => q.topic === "Geometry");
  if (geomCandidates.length > 0) {
    console.log(`[diagnose] geometry recheck: ${geomCandidates.length} questions via ${GEOMETRY_MODEL}`);
    const tg = Date.now();
    await Promise.all(geomCandidates.map(async q => {
      const jpg = pageJpegs[q.pageIndex];
      if (!jpg) return;
      try {
        const meta = await sharp(jpg).metadata();
        const W = meta.width ?? 0;
        const H = meta.height ?? 0;
        if (!W || !H) return;
        const top = Math.max(0, Math.floor(H * (q.yStartPct ?? 0) / 100));
        const bot = Math.min(H, Math.ceil(H * (q.yEndPct ?? 100) / 100));
        const h = Math.max(1, bot - top);
        const region = await sharp(jpg).extract({ left: 0, top, width: W, height: h }).jpeg({ quality: 92 }).toBuffer();
        const result = await remarkGeometryQuestion(region, {
          questionNum: q.questionNum,
          stem: q.stem,
          options: q.options ?? [],
          expectedAnswer: q.expectedAnswer,
          studentAnswer: q.studentAnswer,
          marksAvailable: q.marksAvailable,
        });
        if (result) {
          const before = `${q.marksAwarded}/${q.marksAvailable} (${q.isCorrect ? "✓" : "✗"})`;
          q.expectedAnswer = result.expectedAnswer;
          q.studentAnswer = result.studentAnswer;
          q.isCorrect = result.isCorrect;
          q.marksAwarded = result.marksAwarded;
          q.feedback = result.feedback || q.feedback;
          q.isBlank = !q.studentAnswer.trim();
          const after = `${q.marksAwarded}/${q.marksAvailable} (${q.isCorrect ? "✓" : "✗"})`;
          if (before !== after) {
            console.log(`[diagnose] geometry Q${q.questionNum}: ${before} → ${after}`);
          }
        }
      } catch (err) {
        console.error(`[diagnose] geometry Q${q.questionNum} crop failed:`, err);
      }
    }));
    console.log(`[diagnose] geometry recheck done in ${Date.now() - tg}ms`);
  }

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
        // what the school treats as ground truth. Clamp the score to
        // total available so a runaway per-question sum from
        // duplicate-question detection can't produce nonsense like
        // 93/55. Logged separately if it triggers.
        score: clampScoreLogged(
          coverTeacherAwarded > 0 ? coverTeacherAwarded : flat.reduce((s, q) => s + q.marksAwarded, 0),
          coverPaperTotal > 0 ? coverPaperTotal : flat.reduce((s, q) => s + q.marksAvailable, 0),
          paperId,
        ),
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
