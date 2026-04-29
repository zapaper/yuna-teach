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
import { analyzeExamStructure, type StructureResult } from "@/lib/gemini";

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
  markingSchemeBands: { from: number; to: number; marksPerQ: number }[]; // banner ranges spotted on this page
};

async function diagnosePage(jpeg: Buffer, subjectHint: string, levelHint: string | null): Promise<PageDiagnosis> {
  const ai = getAI();
  const allowedTopics = topicListForSubject(subjectHint);
  const prompt = `You are extracting + marking ONE page of a Singapore primary-school past paper photographed by a parent. The student has handwritten answers on the paper, AND there may already be red-ink marks from the school teacher.

QUESTION DETECTION DISCIPLINE (read carefully — this is the same rule the main extraction pipeline uses, and it's where the previous diagnostic flow has been getting things wrong):

1. Scan ONLY the left-most ~5% of the page from top to bottom.
2. A QUESTION NUMBER is a bare integer (or integer + ".") that is the VERY FIRST thing on a line, FLUSH WITH THE LEFT EDGE, with nothing to its left. e.g. "1.", "2.", "16.", "24.".
3. The following are NOT question numbers — DO NOT split them out as separate questions:
   - "(a)", "(b)", "(i)", "(ii)" — these are sub-parts of the parent question.
   - "(1)", "(2)", "(3)", "(4)" — MCQ option labels (indented, not flush left).
   - Numbers in the question stem, table cells, diagrams, footnotes, or page numbers in the header / footer.
4. ONLY output a question if you can clearly SEE the integer printed at the LEFT MARGIN. NEVER invent or guess. If you can't see "Q14", do NOT output a Q14.
5. Each question is ONE entry — sub-parts (a)/(b)/(c) belong inside that one entry's stem, not their own.
6. Question numbers go in ASCENDING order. If a number on this page is smaller than ones above it, that's a NEW BOOKLET / SECTION (Booklet B) reusing numbers — extract them as-is, but they're a separate sequence.
7. yStartPct = ~1-2% above the question number. yEndPct = top of the NEXT question number on this page (with ~1% padding), or 95 if it's the last on the page.
8. If the page has NO question numbers at the left margin (cover, instructions banner, blank section page) return an empty questions array. DO NOT make up questions.
9. CRITICAL — OEQ pages where the marks are printed as "[N]" near an "Ans:" line. Singapore Booklet B / Section B / Paper 2 OEQ questions look like:
   "  16. The figure below shows...
        ...student writes here...
        Ans: __________ [3]"
   The "[3]" lives in the BOTTOM-RIGHT of the question's region next to or near the "Ans:" / "Answer:" line. Do NOT skip these questions — every numbered question you can see at the left margin must be output, even if there's a lot of blank answer space between the stem and the "Ans:" line. If a page has only ONE OEQ stem near the top with mostly blank answer space below, it's still ONE question — output it with yEndPct=95.

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

DISAMBIGUATION RULES — pay attention before tagging:
- "Geometry" is for questions where the student must reason about SHAPES, ANGLES, AREA, PERIMETER, VOLUME, SYMMETRY, or GEOMETRIC CONSTRUCTIONS. Triangles, circles, polygons, parallel-lines theorems.
- "Statistics" / "Data analysis" / "Graphs" — questions where the diagram is a CHART, BAR GRAPH, LINE GRAPH, PIE CHART, or TABLE OF DATA, and the student is asked to read values, compare quantities, compute averages, or interpret trends. The presence of axes, bars, slices, or a data table is the signal — even if the chart contains rectangular shapes, the question is NOT geometry.
- Fractions / Ratio / Percentage questions can have a pictorial diagram (pie chart, shaded squares) — these are still the algebraic topic, NOT geometry.
- Multi-step word problems with multiple operations: pick the dominant concept (e.g. a problem that ends in solving an equation is "Algebra" even if it briefly references area).

Before outputting the topic, ask: "what concept is this question actually testing?" not "what shape appears in the figure?".

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
10. "marksAvailable": the marks the question is worth. CRITICAL — read this in priority order:
    a. SECTION HEADER FIRST. Singapore primary papers print a marking scheme banner at the top of each section / booklet. Examples:
       "Section A: 25 questions. Each question carries 1 mark. (25 marks)"
       "Section B (15 marks): 5 questions of 3 marks each."
       "Booklet B: For each question from 1 to 10, four options are given. Choose the most suitable answer. (10 marks)"
       "Questions 1 to 28 carry 2 marks each."
       If the page contains such a banner OR you can recall it from the cover, use it as the default mark for every question in that section. e.g. if Section A says "1 mark each", every question in Section A is worth 1 mark — DO NOT randomly upgrade an OEQ subpart to 2 marks just because it looks long.
    b. Per-question "[N]" notation. CRITICAL — this is the most common way Singapore primary papers (especially Booklet B / Section B OEQ) print marks. ALWAYS scan for it before defaulting. Look in TWO places:
       i. AT THE END OF THE STEM, immediately after the question text, e.g. "What is the area of triangle ABC?  [2]"
       ii. NEAR THE ANSWER LINE — usually BOTTOM-RIGHT of the question's region, on the same line as "Ans: ___" or "Answer: ___". The "[3]" can be just before, after, or above that "Ans:" label. Examples:
         - "Ans: ____________ [3]"
         - "Answer:                        [5]"
         - A bare "[2]" floating in the bottom-right corner of the question's space
       The "[N]" is NEVER a question number, NEVER a line/footnote reference. It's always a small bracketed integer (1-10).
       This notation OVERRIDES the section default. If you see "[3]" in either location, marksAvailable for that question is exactly 3.

    DO NOT skip a question just because you can't immediately see a marks indicator — re-scan the bottom-right of the question's region for "[N]" before falling through to the default.
    c. Last resort. If neither (a) nor (b) is visible, default 1 for MCQ, 2 for OEQ that genuinely looks like a multi-mark question — but be conservative; over-allocation is the most common error.
    Half-marks allowed (e.g. 0.5).
11. "marksAwarded": the marks the student actually earned (0..marksAvailable). Use partial marks for OEQ when only some of the required components are present. For MCQ, all-or-nothing (0 or marksAvailable).
12. "yStartPct" and "yEndPct": 0-100 vertical bounds of the question on the cropped image.

CRITICAL: Output EVERY question on the page, even compactly-laid-out ones. Long papers often have 4-8 questions per page. Do not skip questions just because they look similar to neighbours.

INSTRUCTION / SECTION HEADER PAGES (CRITICAL FOR MARK ALLOCATION):
Singapore primary exam booklets begin every section with an INSTRUCTIONS banner that explicitly states the mark scheme. These are the SINGLE MOST IMPORTANT signal for marksAvailable — every question that follows in that section inherits the banner's per-question mark count.

Examples of how the banner reads:
- "Section A (28 marks): There are 14 questions in this section. Each question carries 1 mark."
- "Section B (40 marks): There are 13 questions in this section. Each question carries 2, 4 or 5 marks. Show your working clearly..."
- "Booklet A: Questions 1 to 28 each carry 1 mark."
- "Booklet B (50 marks): Questions 1 to 5 carry 2 marks each. Questions 6 to 17 carry 3, 4 or 5 marks each."

When you see such a banner: USE IT. Tag every question that follows it (until the next banner) with the per-question marks the banner specifies. Do NOT randomly assign 2 marks to a 1-mark MCQ just because the answer space is large.

Skip cover pages, pure instruction pages, and any non-question content from the questions array (but DO read them for the totals fields below AND for the section's mark scheme that propagates to subsequent questions).

PAPER TOTALS (CRUCIAL — overrides per-question marks):
On a cover page, header, or final summary box, primary-school papers usually print a paper total like "Total: ___ / 50" and the teacher writes the awarded score in red ("31.5"). Look carefully on this page for either:
- "paperTotalMarks": the printed total marks for the WHOLE paper (e.g. 50). Null if not visible on this page.
- "teacherAwardedMarks": the teacher's handwritten total score for the WHOLE paper. Null if not visible.

CRITICAL — handwritten fractional marks: teachers commonly write half marks as "31 1/2", "31½", "31.5", or "31 ½ ". Treat ALL of these as 31.5 (THIRTY-ONE POINT FIVE), NOT as 36, 312, or any other concatenation. The "1/2" fraction is one symbol, not two digits. If you see a number followed by "1/2" or "½" or ".5" or "0.5", the awarded marks are <number> + 0.5. Be very careful with this — past runs misread "31 1/2" as "36".

Both fields apply to the WHOLE paper. If you spot them on any page, return the actual numbers — the server will use them as authoritative totals over our per-question sums. If unsure, return null rather than guessing.

MARKING-SCHEME BANNERS:
Singapore primary papers begin every section with a small banner like:
- "Questions 1 to 10 carry 1 mark each."
- "Questions 11 to 15 carry 2 marks each."
- "For Booklet B, Questions 1 to 5 each carry 2 marks."
If THIS page has any such banner, output every range as one entry in markingSchemeBands. Multiple banners on the same page = multiple entries. No banner = empty array.

OUTPUT FORMAT: a JSON OBJECT with these keys:
- "questions": JSON array of question records as described above
- "paperTotalMarks": number or null
- "teacherAwardedMarks": number or null
- "markingSchemeBands": array of {"from": <int>, "to": <int>, "marksPerQ": <number>} — one per banner spotted on THIS page; [] if none

NO commentary.`;
  try {
    const resp = await withRetries("diagnosePage", 5, () => ai.models.generateContent({
      // Was gemini-2.5-pro — flash is ~5× faster and reliably handles
      // the structured-output + image OCR we need here. Pro was
      // hanging on the merged prompt long enough to trigger undici's
      // headers-timeout and stall the whole paper.
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } },
        ],
      }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const raw = resp.text ?? "{}";
    const parsed = safeJsonParse<{ questions?: DiagnosedQuestion[]; paperTotalMarks?: number | null; teacherAwardedMarks?: number | null; markingSchemeBands?: { from?: number; to?: number; marksPerQ?: number }[] } | DiagnosedQuestion[]>("diagnosePage", raw, {});
    // Tolerate the legacy plain-array shape in case Gemini drops the wrapper object.
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.questions) ? parsed.questions : []);
    const paperTotalMarks = (!Array.isArray(parsed) && typeof parsed.paperTotalMarks === "number" && parsed.paperTotalMarks > 0) ? parsed.paperTotalMarks : null;
    const teacherAwardedMarks = (!Array.isArray(parsed) && typeof parsed.teacherAwardedMarks === "number" && parsed.teacherAwardedMarks >= 0) ? parsed.teacherAwardedMarks : null;
    const markingSchemeBands: { from: number; to: number; marksPerQ: number }[] = [];
    if (!Array.isArray(parsed) && Array.isArray(parsed.markingSchemeBands)) {
      for (const b of parsed.markingSchemeBands) {
        const from = Number(b.from);
        const to = Number(b.to);
        const m = Number(b.marksPerQ);
        if (Number.isFinite(from) && Number.isFinite(to) && Number.isFinite(m) && from > 0 && to >= from && m > 0) {
          markingSchemeBands.push({ from, to, marksPerQ: m });
        }
      }
    }
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
    return { questions, paperTotalMarks, teacherAwardedMarks, markingSchemeBands };
  } catch (err) {
    console.error("[diagnose] page analysis failed:", err);
    return { questions: [], paperTotalMarks: null, teacherAwardedMarks: null, markingSchemeBands: [] };
  }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// Robust JSON.parse for Gemini responses. Tolerates the model
// occasionally wrapping output in ```json ... ``` fences despite our
// responseMimeType: "application/json" config, and trims stray
// whitespace. Returns the fallback (caller-supplied) on parse failure
// AND logs the raw text so we can spot the truncation / fence /
// content-filter issue in Railway. The label distinguishes which call
// site failed.
function safeJsonParse<T>(label: string, raw: string, fallback: T): T {
  if (!raw) return fallback;
  let cleaned = raw.trim();
  // Strip ```json or ``` fences from start and end (some Gemini
  // responses still wrap in markdown despite responseMimeType).
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    console.error(`[diagnose] ${label} JSON.parse failed: ${err instanceof Error ? err.message : String(err)} | raw (first 400 chars): ${raw.slice(0, 400)}`);
    return fallback;
  }
}

// Wrap any Gemini call so transient fetch failures (UND_ERR_HEADERS_TIMEOUT,
// ECONNRESET, AggregateError) get retried with linear backoff instead
// of taking out the whole diagnostic. Each attempt is its own
// generateContent invocation; we surface the last error if all retries
// fail so callers can fall back to a sensible default.
async function withRetries<T>(label: string, attempts: number, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Surface err.cause (undici wraps the real reason there) so we
      // can tell timeout vs DNS vs reset apart in the logs.
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const causeMsg = cause ? ` cause=${cause.code ?? ""}${cause.code && cause.message ? " " : ""}${cause.message ?? ""}` : "";
      console.warn(`[diagnose] ${label} attempt ${i}/${attempts} failed: ${msg}${causeMsg}`);
      if (i < attempts) {
        // Exponential backoff with jitter — much kinder when the
        // failure is rate-limit / connection-pool related.
        const base = 1500 * Math.pow(2, i - 1); // 1.5s, 3s, 6s, 12s, 24s
        const jitter = Math.random() * 500;
        await new Promise(r => setTimeout(r, base + jitter));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Bounded-parallelism map. We were firing 80+ Gemini calls at once on
// a 38-page paper (per-page diagnose × 38, marking-scheme × 38, cover-
// scan × 4) and hitting the API's connection / rate-limit ceiling —
// the resulting fetch failures retried but eventually exhausted. Cap
// active calls to LIMIT and queue the rest.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// Marking-scheme banner ranges (e.g. 'Questions 1-10 carry 1 mark each')
// are now read inside the merged per-page diagnose call rather than a
// separate pass. Type kept for callers that consume them downstream.
type MarkingBand = { from: number; to: number; marksPerQ: number };


// Apply the discovered banner ranges to a list of questions. Returns
// how many were touched. Multiple banners can cover the same range
// (e.g. one on the cover plus one repeated near the questions); we
// take the LATER banner if there's overlap, since that's the more
// specific one. Each band is independent.
function applyMarkingBands(flat: { questionNum: string; marksAwarded: number; marksAvailable: number; isCorrect: boolean }[], bands: MarkingBand[]): number {
  if (bands.length === 0) return 0;
  // Build a per-Q-number lookup, last band wins.
  const perQ = new Map<number, number>();
  for (const b of bands) {
    for (let n = b.from; n <= b.to; n++) perQ.set(n, b.marksPerQ);
  }
  let touched = 0;
  for (const q of flat) {
    const m = q.questionNum.match(/^(\d+)/);
    if (!m) continue;
    const num = Number(m[1]);
    const corrected = perQ.get(num);
    if (typeof corrected !== "number" || corrected === q.marksAvailable) continue;
    const ratio = q.marksAvailable > 0 ? q.marksAwarded / q.marksAvailable : (q.isCorrect ? 1 : 0);
    q.marksAvailable = corrected;
    q.marksAwarded = Math.min(corrected, Math.round(ratio * corrected * 2) / 2);
    touched++;
  }
  return touched;
}

// Group the flat question list into booklets/sections by detecting
// question-number resets. Walk in extraction order — each time the
// parsed numeric question number drops below the previous one, start
// a new booklet. e.g. Q1..Q30 then Q1..Q15 → two booklets.
type BookletSummary = { label: string; firstQ: string; lastQ: string; earned: number; available: number; questionCount: number };
function summariseBooklets(flat: { questionNum: string; marksAwarded: number; marksAvailable: number }[]): BookletSummary[] {
  const booklets: { items: typeof flat }[] = [];
  let current: typeof flat = [];
  let prevNum = -1;
  for (const q of flat) {
    const m = q.questionNum.match(/^(\d+)/);
    const num = m ? Number(m[1]) : NaN;
    if (Number.isFinite(num) && num < prevNum) {
      // Number reset: start a new booklet.
      if (current.length > 0) booklets.push({ items: current });
      current = [];
    }
    current.push(q);
    if (Number.isFinite(num)) prevNum = num;
  }
  if (current.length > 0) booklets.push({ items: current });
  return booklets.map((b, i) => ({
    label: `Booklet ${String.fromCharCode("A".charCodeAt(0) + i)}`,
    firstQ: b.items[0].questionNum,
    lastQ: b.items[b.items.length - 1].questionNum,
    earned: b.items.reduce((s, q) => s + q.marksAwarded, 0),
    available: b.items.reduce((s, q) => s + q.marksAvailable, 0),
    questionCount: b.items.length,
  }));
}

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
// When the per-question marksAvailable sums exceed the printed paper
// total (Gemini over-allocates because each per-page call has no
// global view), ask the model in one shot to look at all the question
// numbers + currently-assigned marks and rebalance them to match the
// actual total. Returns a Map of questionNum → corrected marksAvailable.
async function auditMarksAvailable(
  questions: { questionNum: string; marksAvailable: number }[],
  paperTotal: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (paperTotal <= 0 || questions.length === 0) return out;
  const ai = getAI();
  const prompt = `You are auditing per-question mark allocations on a Singapore primary-school paper. The printed paper total is ${paperTotal} marks. Below is the list of questions detected by another AI pass, with the marks each was assigned. The sum of those is ${questions.reduce((s, q) => s + q.marksAvailable, 0)}, which exceeds the paper total — so some questions were over-allocated.

Your job: produce a corrected mark allocation per question. Rules:
- The sum of corrected marksAvailable across ALL questions MUST equal exactly ${paperTotal}.
- Use INTEGER or HALF marks only (e.g. 0.5, 1, 1.5, 2). No quarter marks.
- Most MCQs are worth 1 mark.
- OEQ subparts are typically 1-3 marks each, with the harder/longer ones worth more.
- Distribute reductions across the over-allocated questions sensibly — don't drop everything to 1.
- Preserve the rough relative weight: a question that was 3 marks should not become 1.

INPUT:
${JSON.stringify(questions.map(q => ({ q: q.questionNum, m: q.marksAvailable })))}

OUTPUT (JSON array, same length, same order):
[{"q": "1", "m": 1}, {"q": "2", "m": 1}, ...]
NO commentary.`;
  try {
    const resp = await withRetries("auditMarksAvailable", 3, () => ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const raw = resp.text ?? "[]";
    const parsed = JSON.parse(raw) as { q?: string; m?: number }[];
    if (!Array.isArray(parsed)) return out;
    for (const e of parsed) {
      if (typeof e.q !== "string" || typeof e.m !== "number" || e.m < 0) continue;
      out.set(e.q.trim().toLowerCase(), e.m);
    }
  } catch (err) {
    console.error("[diagnose] marks audit failed:", err);
  }
  return out;
}

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
    const resp = await withRetries(`detectMcqAnswerOne ${qLabel}`, 3, () => ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: regionJpeg.toString("base64") } },
        ],
      }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
    const raw = resp.text ?? "{}";
    const parsed = JSON.parse(raw) as { isOne?: boolean };
    return Boolean(parsed.isOne);
  } catch (err) {
    console.error(`[diagnose] detectMcqAnswerOne ${qLabel} failed:`, err);
    return false;
  }
}

function isMcqQuestion(q: { options?: string[]; expectedAnswer?: string }): boolean {
  // ONLY treat as MCQ if the AI returned an options array of >= 2.
  // The previous "expectedAnswer is a single digit/letter" fallback
  // misclassified OEQ math answers like "1" or numeric short
  // answers, which then fired the MCQ-1 recheck on OEQ regions.
  return Array.isArray(q.options) && q.options.length >= 2;
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
    const resp = await withRetries(`remarkGeometry Q${q.questionNum}`, 2, () => ai.models.generateContent({
      model: GEOMETRY_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: regionJpeg.toString("base64") } },
        ],
      }],
      config: { temperature: 0, responseMimeType: "application/json" },
    }));
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

// One-shot Gemini-flash call: scan every page for marks-guidance
// banner text and return distinct lines. The regular structure
// prompt is supposed to do this but in practice catches only the
// first banner — papers commonly print 'Questions 1-5 carry 2 marks
// each' on the cover and 'Questions 11-15 carry 2 marks each' partway
// through. Sending all pages in one call lets flash see every banner
// at once.
// Marks-guidance ranges in structured form so downstream marking can
// look up 'is Q5 in Booklet B worth 2 marks?' efficiently.
type MarksRange = { from: number; to: number; marksPerQ: number; note: string };

async function scanAllPagesForMarksGuidance(jpegs: Buffer[], structure: StructureResult): Promise<{ lines: string[]; ranges: MarksRange[] }> {
  const ai = getAI();
  const imageParts = jpegs.map((b, i) => [
    { text: `[Page ${i}]` },
    { inlineData: { mimeType: "image/jpeg" as const, data: b.toString("base64") } },
  ]).flat();
  // Pass the already-detected paper layout so Gemini doesn't guess
  // booklet attribution from scratch. e.g. if it spots a banner on
  // page 12 and the structure says page 10 starts Booklet B, we want
  // 'Booklet B' as the note, not 'Booklet A'.
  const papersContext = (structure.papers ?? []).map(p =>
    `- ${p.label ?? "Paper"}: starts page ${p.firstQuestionPageIndex ?? "?"}, expects ~${p.expectedQuestionCount ?? "?"} questions`
  ).join("\n");
  const prompt = `Look at every page above. Find ONLY the printed rules that ALLOCATE MARKS PER QUESTION RANGE. The signal phrasing is "Questions X to Y carry N mark(s) each" or "Question X carries N marks".

PAPER LAYOUT (use this to attribute each banner correctly to a booklet / paper):
${papersContext || "(no layout context — make your best guess)"}

When you spot a banner, note which paper/booklet it belongs to by looking at the page index it's on relative to the layout above. The same Q1-Q5 range can appear in multiple booklets — never collapse them into one entry.

INCLUDE rules like:
- "Questions 1 to 10 carry 1 mark each."
- "Questions 11 to 15 carry 2 marks each."
- "Questions 1 to 5 carry 2 marks each."     (Booklet B reuses numbering)
- "Each question in Section A carries 1 mark."

EXCLUDE — do not return any of these:
- Instructions to the student ("show your working", "shade the correct oval", "write your answers in the spaces provided", "give your answers in the units stated").
- Generic notes about marks notation ("The number of marks available is shown in brackets [ ] at the end of each question").
- Choice instructions ("Make your choice (1, 2, 3 or 4)").
- Bare section totals on their own ("(20 marks)" / "(45 marks)").
- Cover-page totals ("Total: 100 marks").

Output a JSON object:
{
  "ranges": [
    {"from": 1, "to": 10, "marksPerQ": 1, "note": "Booklet A"},
    {"from": 11, "to": 15, "marksPerQ": 2, "note": "Booklet A"},
    {"from": 1, "to": 5, "marksPerQ": 2, "note": "Booklet B"}
  ]
}

- "from" / "to": question-number range (integer).
- "marksPerQ": marks each question in that range carries (number, halves allowed).
- "note": which booklet / section the range belongs to if you can tell from context (e.g. "Booklet A", "Booklet B", "Section A"); empty string otherwise.

Deduplicate identical ranges. If you can't see any allocation rule, return {"ranges": []}. NO commentary.`;
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 4000 },
    });
    const raw = resp.text ?? "{}";
    const parsed = safeJsonParse<{ ranges?: { from?: number; to?: number; marksPerQ?: number; note?: string }[] }>("scanMarksGuidance", raw, {});
    if (!Array.isArray(parsed.ranges)) return { lines: [], ranges: [] };
    // Convert each {from, to, marksPerQ, note} into a clean one-liner.
    // Dedupe (same from+to+marks+note collapses to one).
    const seen = new Set<string>();
    const lines: string[] = [];
    const ranges: MarksRange[] = [];
    for (const r of parsed.ranges) {
      const from = Number(r.from);
      const to = Number(r.to);
      const m = Number(r.marksPerQ);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(m)) continue;
      if (from <= 0 || to < from || m <= 0) continue;
      const noteStr = (r.note ?? "").toString().trim();
      const key = `${from}-${to}-${m}-${noteStr.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const noteSuffix = noteStr ? ` (${noteStr})` : "";
      const rangeLabel = from === to ? `Question ${from}` : `Questions ${from} to ${to}`;
      const markLabel = m === 1 ? "1 mark each" : `${m} marks each`;
      lines.push(`${rangeLabel} carry ${markLabel}${noteSuffix}.`);
      ranges.push({ from, to, marksPerQ: m, note: noteStr });
    }
    return { lines, ranges };
  } catch (err) {
    console.error("[diagnose] scanAllPagesForMarksGuidance failed:", err);
    return { lines: [], ranges: [] };
  }
}

// STRUCTURE-ONLY MODE.
// Per parent request: 'do not extract pages for now, I am wasting tokens'.
// We render the PDF to per-page JPGs, then run ONLY the regular paper-
// extraction structure-analysis prompt (the same one /api/exam/upload
// uses) to get header + sections + per-paper expectations. The result
// is logged in full to Railway and a compact summary is emailed to
// the parent. No per-question marking, no geometry recheck, no MCQ-1
// recheck. Once the structure output looks right we'll layer those
// passes back on top.
async function runDiagnosisInBackground(
  attachments: DiagnoseAttachment[],
  parent: DiagnoseParent,
  student: { id: string; name: string; level: number | null },
  subjectStr: string,
  fromEmail: string,
): Promise<void> {
  // 1) Render PDF / image attachments to per-page JPG buffers.
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

  // 2) Save a placeholder paper so the parent dashboard reflects the
  // submission immediately. We mark it in_progress and never flip it
  // to 'complete' in this stripped flow — the parent will see it as
  // 'Marking…' until we wire the rest back on.
  const placeholder = await prisma.examPaper.create({
    data: {
      title: `Diagnostic (structure preview) — ${new Date().toLocaleDateString("en-SG", { day: "2-digit", month: "short", year: "numeric" })}`,
      subject: null,
      level: student.level ? `Primary ${student.level}` : null,
      paperType: "diagnostic",
      pageCount: pageJpegs.length,
      userId: parent.id,
      assignedToId: student.id,
      instantFeedback: true,
      completedAt: new Date(),
      markingStatus: "in_progress",
      metadata: { source: "diagnose-email", subjectHintFromEmail: subjectStr, mode: "structure-only" } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const paperId = placeholder.id;
  const subDir = path.join(SUBMISSIONS_DIR, paperId);
  await fs.mkdir(subDir, { recursive: true });
  for (let i = 0; i < pageJpegs.length; i++) {
    await fs.writeFile(path.join(subDir, `page_${i}.jpg`), pageJpegs[i]);
  }
  console.log(`[diagnose] paper=${paperId} created in_progress with ${pageJpegs.length} page JPGs saved`);

  // 3) Run the regular extraction's structure-analysis prompt verbatim.
  console.log(`[diagnose] structure-only mode: running analyzeExamStructure on ${pageJpegs.length} pages`);
  const t0 = Date.now();
  let structure: StructureResult | null = null;
  try {
    const imagesB64 = pageJpegs.map(b => b.toString("base64"));
    structure = await analyzeExamStructure(imagesB64);
  } catch (err) {
    console.error("[diagnose] structure analysis failed:", err);
    await maybeReply(fromEmail, "Diagnose: structure analysis failed", "We couldn't read the paper structure from the photos you sent. Try a clearer scan or PDF.").catch(() => {});
    return;
  }
  console.log(`[diagnose] structure analysis done in ${Date.now() - t0}ms`);

  // 4) Marks-guidance enhancement pass. The regular structure prompt
  // is supposed to scan every page for marks-guidance banners
  // ("Questions 1-5 carry 2 marks each. Questions 10-20 carry 1 mark
  // each.") but in practice it often only catches the first one. Run
  // a separate focused pass over all pages and merge findings.
  let marksRanges: MarksRange[] = [];
  try {
    const extra = await scanAllPagesForMarksGuidance(pageJpegs, structure);
    if (extra.lines.length > 0) {
      // REPLACE the structure prompt's marksGuidance entirely. The
      // structured-range pass has booklet attribution and excludes
      // student instructions; merging would re-introduce the noise +
      // duplicates that prompted this rewrite.
      if (!structure.header) {
        structure.header = { school: "", level: "", subject: "", year: "", semester: "", title: "" };
      }
      structure.header.marksGuidance = extra.lines.join(" ");
      marksRanges = extra.ranges;
      console.log(`[diagnose] marks-guidance enhancement: replaced with ${extra.lines.length} structured banner(s)`);
    }
  } catch (err) {
    console.error("[diagnose] marks-guidance enhancement failed:", err);
  }
  // 5) Dump the full structure JSON to the log so the operator can
  // sanity-check it without opening the DB.
  console.log("[diagnose] STRUCTURE OUTPUT BEGIN ---");
  console.log(JSON.stringify(structure, null, 2));
  console.log("[diagnose] STRUCTURE OUTPUT END ---");

  // 6) Per-page extraction + marking. Cap at 4 concurrent gemini-flash
  // calls. The diagnosePage prompt now has both the structure layout
  // and the marks-guidance ranges as context, so it can extract
  // questions and read teacher's red marks without inventing question
  // numbers or guessing per-question marks.
  const subjectHint = structure.header?.subject ?? subjectStr;
  const levelHint = structure.header?.level ?? (student.level ? `Primary ${student.level}` : null);
  console.log(`[diagnose] per-page extract+mark on ${pageJpegs.length} pages`);
  let pagesDone = 0;
  const tPages = Date.now();
  const perPage = await mapWithConcurrency(pageJpegs, 4, async (buf, i) => {
    const tp = Date.now();
    const out = await diagnosePage(buf, subjectHint, levelHint);
    pagesDone++;
    console.log(`[diagnose] p${i} done in ${Date.now() - tp}ms (${pagesDone}/${pageJpegs.length})`);
    return out;
  });
  console.log(`[diagnose] per-page done in ${Date.now() - tPages}ms`);

  // Flatten + page-adjacency dedup (same Q on consecutive pages = a
  // multi-page continuation; far-apart Q numbers reset = new booklet).
  const rawFlat = perPage.flatMap((page, pageIdx) => page.questions.map(q => ({ ...q, pageIndex: pageIdx })));
  const lastSeenPageByQNum = new Map<string, number>();
  const flat = rawFlat.filter(q => {
    const key = q.questionNum.trim().toLowerCase();
    if (!key || key === "?") return true;
    const prev = lastSeenPageByQNum.get(key);
    if (prev !== undefined && q.pageIndex - prev <= 1) return false;
    lastSeenPageByQNum.set(key, q.pageIndex);
    return true;
  });

  // 7) Override marksAvailable from the marks-guidance ranges. Each
  // question is matched to the booklet whose page range contains its
  // pageIndex; then we look up the (questionNum, booklet) → marksPerQ
  // entry. Falls back to whatever the per-page call inferred (which
  // typically reads "[N]" inline notation).
  const papers = Array.isArray(structure.papers) ? structure.papers : [];
  function paperForPage(pageIdx: number): string {
    // The paper whose firstQuestionPageIndex is the largest one ≤ pageIdx.
    let best: string = "";
    let bestStart = -1;
    for (const p of papers) {
      const start = typeof p.firstQuestionPageIndex === "number" ? p.firstQuestionPageIndex : -1;
      if (start <= pageIdx && start > bestStart) {
        best = p.label ?? "";
        bestStart = start;
      }
    }
    return best;
  }
  let touchedByGuidance = 0;
  for (const q of flat) {
    const m = q.questionNum.match(/^(\d+)/);
    if (!m) continue;
    const num = Number(m[1]);
    const booklet = paperForPage(q.pageIndex);
    // Pick the most-specific range matching this question. Booklet
    // match wins; un-noted ranges are an OK fallback.
    const candidates = marksRanges.filter(r => num >= r.from && num <= r.to);
    const exactBooklet = candidates.find(r => r.note && booklet && r.note.toLowerCase().includes(booklet.toLowerCase().split(" ").pop()!));
    const fallback = candidates.find(r => !r.note || r.note === "");
    const chosen = exactBooklet ?? fallback ?? candidates[0];
    if (chosen) {
      const ratio = q.marksAvailable > 0 ? q.marksAwarded / q.marksAvailable : (q.isCorrect ? 1 : 0);
      q.marksAvailable = chosen.marksPerQ;
      q.marksAwarded = Math.min(chosen.marksPerQ, Math.round(ratio * chosen.marksPerQ * 2) / 2);
      touchedByGuidance++;
    }
  }
  if (touchedByGuidance > 0) {
    console.log(`[diagnose] marks-guidance overrode marksAvailable on ${touchedByGuidance} of ${flat.length} questions`);
  }

  // 8) Final score + topic + booklet summary.
  // Pick the denominator carefully: if the per-question sum covers the
  // printed total (within 5%), use the printed total. If the AI fell
  // materially short of the printed total (e.g. it detected 68 marks
  // of questions on a 100-mark paper), the AI under-extracted — using
  // 100 as the denominator would mean dividing the AI's earned marks
  // by a base that includes 32 marks of un-marked questions, which
  // distorts the percentage downward. In that case use the AI sum so
  // the percentage reflects the AI's actual coverage.
  const aiTotalEarned = flat.reduce((s, q) => s + q.marksAwarded, 0);
  const aiTotalAvailable = flat.reduce((s, q) => s + q.marksAvailable, 0);
  const printedTotal = Number(structure.header?.totalMarks ?? "");
  const printedTotalValid = Number.isFinite(printedTotal) && printedTotal > 0;
  const aiCoversPrinted = printedTotalValid && aiTotalAvailable >= printedTotal * 0.95;
  const totalAvailable = aiCoversPrinted
    ? printedTotal
    : (printedTotalValid && aiTotalAvailable > 0 ? aiTotalAvailable : (printedTotalValid ? printedTotal : aiTotalAvailable));
  const totalEarned = totalAvailable > 0 ? Math.min(aiTotalEarned, totalAvailable) : aiTotalEarned;
  if (printedTotalValid && !aiCoversPrinted) {
    console.warn(`[diagnose] AI per-q sum ${aiTotalAvailable} only covers ${Math.round(100 * aiTotalAvailable / printedTotal)}% of the printed total ${printedTotal} — using AI sum as denominator`);
  }
  console.log(`[diagnose] score: ${totalEarned}/${totalAvailable} (per-q sums ${aiTotalEarned}/${aiTotalAvailable}, printed total=${printedTotalValid ? printedTotal : "?"})`);

  // Topic-by-topic + weak/strong rollup.
  const byTopic = new Map<string, { earned: number; available: number; total: number; right: number }>();
  for (const q of flat) {
    const t = q.topic || "Untagged";
    const cur = byTopic.get(t) ?? { earned: 0, available: 0, total: 0, right: 0 };
    cur.earned += q.marksAwarded;
    cur.available += q.marksAvailable;
    cur.total += 1;
    if (q.isCorrect) cur.right += 1;
    byTopic.set(t, cur);
  }
  const topicRows = Array.from(byTopic.entries()).map(([topic, v]) => ({ topic, ...v, lost: v.available - v.earned }));
  const weak = [...topicRows].filter(t => t.lost > 0).sort((a, b) => b.lost - a.lost).slice(0, 3);
  const strong = topicRows.filter(t => t.total >= 2 && t.lost === 0).slice(0, 5);
  const topicChart = [...topicRows].filter(t => t.available > 0).sort((a, b) => (a.earned / a.available) - (b.earned / b.available));
  const booklets = summariseBooklets(flat);

  // 9) Persist questions + finalise the paper.
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
        title: structure.header?.title || `Diagnostic — ${new Date().toLocaleDateString("en-SG", { day: "2-digit", month: "short", year: "numeric" })}`,
        subject: structure.header?.subject ?? null,
        level: structure.header?.level ?? (student.level ? `Primary ${student.level}` : null),
        totalMarks: String(totalAvailable),
        score: totalEarned,
        metadata: { source: "diagnose-email", subjectHintFromEmail: subjectStr, mode: "extract+mark", structure } as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);

  // 10) Email the parent the full summary.
  await maybeReply(
    fromEmail,
    `Diagnose: ${student.name} — ${formatNum(totalEarned)}/${formatNum(totalAvailable)} marks`,
    buildSummaryHtml(student.name, totalAvailable, totalEarned, weak, strong, booklets, topicChart, parent.id, paperId),
    { html: true },
  ).catch((err) => console.error("[diagnose] reply email failed:", err));
  console.log(`[diagnose] paper=${paperId} marks=${totalEarned}/${totalAvailable} weak=[${weak.map(w => `${w.topic}(-${w.lost})`).join(", ")}]`);
}

function buildStructurePreviewHtml(studentName: string, s: StructureResult): string {
  const h = s.header ?? {};
  const papers = Array.isArray(s.papers) ? s.papers : [];
  const escape = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const headerRows: { label: string; value: string }[] = [];
  if (h.school) headerRows.push({ label: "School", value: h.school });
  if (h.level) headerRows.push({ label: "Level", value: h.level });
  if (h.subject) headerRows.push({ label: "Subject", value: h.subject });
  if (h.year) headerRows.push({ label: "Year", value: h.year });
  if (h.semester) headerRows.push({ label: "Semester", value: h.semester });
  if (h.totalMarks) headerRows.push({ label: "Total marks", value: h.totalMarks });
  const headerHtml = headerRows.length === 0
    ? "<p>No header detected.</p>"
    : `<table style="font-size:13px; border-collapse:collapse;">${headerRows.map(r => `<tr><td style="padding:3px 12px 3px 0; color:#43474f;">${escape(r.label)}</td><td style="padding:3px 0; color:#001e40; font-weight:bold;">${escape(r.value)}</td></tr>`).join("")}</table>`;
  // marksGuidance intentionally omitted from the email — it's noisy
  // and the per-paper / per-section counts below already convey the
  // useful structure to the parent. Still kept on the server side
  // (paper.metadata.structure) for downstream marking.
  const guidance = "";
  const papersHtml = papers.map(p => {
    const sections = Array.isArray(p.sections) ? p.sections : [];
    const sectionRows = sections.map(sec => `<tr>
      <td style="padding:4px 12px 4px 0; color:#001e40;">${escape(sec.name ?? "")}</td>
      <td style="padding:4px 12px 4px 0; color:#43474f;">${escape(sec.type ?? "")}</td>
      <td style="padding:4px 12px 4px 0; color:#43474f; text-align:right;">${sec.questionCount ?? "?"} questions</td>
      <td style="padding:4px 0; color:#43474f; text-align:right;">${sec.marksPerQuestion ?? "varies"} mark${sec.marksPerQuestion === 1 ? "" : "s"} each</td>
    </tr>`).join("");
    return `<div style="margin-top:14px; padding:12px 14px; background:#f5f8ff; border-radius:10px;">
      <p style="margin:0 0 6px; font-weight:bold; color:#001e40;">${escape(p.label ?? "Paper")}</p>
      <p style="margin:0; font-size:13px; color:#43474f;">${p.expectedQuestionCount ?? "?"} questions; first question on page ${p.firstQuestionPageIndex ?? "?"}</p>
      ${sections.length ? `<table style="margin-top:8px; font-size:13px; border-collapse:collapse; width:100%;">${sectionRows}</table>` : ""}
    </div>`;
  }).join("");
  return `<!doctype html><html><body style="font-family:-apple-system,system-ui,sans-serif; max-width:560px; margin:0 auto; color:#0b1c30; line-height:1.5;">
<h2 style="color:#001e40; margin-bottom:4px;">Diagnose preview for ${escape(studentName)}</h2>
<p style="color:#43474f; margin-top:0;">Structure-only run. Per-question marking is paused while we tune the paper-structure pass.</p>
<h3 style="color:#001e40;">Header</h3>
${headerHtml}
${guidance}
<h3 style="color:#001e40; margin-top:18px;">Papers / booklets detected</h3>
${papersHtml || "<p>None detected.</p>"}
<p style="margin-top:24px; color:#43474f;">From the MarkForYou Team.</p>
</body></html>`;
}

function buildSummaryHtml(
  studentName: string,
  totalAvailable: number,
  totalEarned: number,
  weak: { topic: string; earned: number; available: number; lost: number }[],
  strong: { topic: string; earned: number; available: number; total: number }[],
  booklets: BookletSummary[],
  topicChart: { topic: string; earned: number; available: number; total: number }[],
  parentId: string,
  paperId: string,
): string {
  const dashboardUrl = `${APP_URL}/home/${parentId}?focusedSuggest=${encodeURIComponent(weak.map(w => w.topic).join(","))}`;
  const reviewUrl = `${APP_URL}/exam/${paperId}/review?userId=${parentId}`;

  // Preamble: lead with strengths, transition into weak areas. If
  // there are no clear strengths or no clear weak areas, soften the
  // copy so it never feels accusatory or robotically templated.
  const strongCopy = strong.length === 0
    ? `<p>${escapeHtml(studentName)} attempted every question — nice effort across the paper.</p>`
    : `<p>${escapeHtml(studentName)} did really well in <strong>${strong.map(s => escapeHtml(s.topic)).join("</strong>, <strong>")}</strong> — every question correct in those topics.</p>`;

  const weakHeading = weak.length === 0
    ? ""
    : `<p>That said, we spotted a few areas where ${escapeHtml(studentName)} may benefit from more practice:</p>`;

  const weakList = weak.length === 0
    ? "<p>And there are no obvious weak topics — the deductions were spread evenly across the paper.</p>"
    : `<ul style="margin: 8px 0 18px;">${weak.map(w => `<li style="margin: 4px 0;"><strong>${escapeHtml(w.topic)}</strong> — lost ${formatNum(w.lost)} mark${w.lost === 1 ? "" : "s"} (${formatNum(w.earned)}/${formatNum(w.available)})</li>`).join("")}</ul>`;

  // Multi-booklet papers get an explicit per-booklet tally so the
  // parent sees the structure instead of one headline number.
  const bookletBreakdown = booklets.length > 1
    ? `<div style="background:#f5f8ff; border:1px solid #dce4f4; border-radius:10px; padding:12px 16px; margin: 12px 0 18px;">
  <p style="margin:0 0 6px; font-weight:bold; color:#001e40;">Paper diagnosis</p>
  <p style="margin:0 0 8px; font-size:13px; color:#43474f;">Across ${booklets.length} booklets / sections:</p>
  <ul style="margin:0; padding-left:18px; font-size:14px;">
    ${booklets.map(b => `<li style="margin:2px 0;"><strong>${escapeHtml(b.label)}</strong> (Q${escapeHtml(b.firstQ)}–Q${escapeHtml(b.lastQ)}) — ${formatNum(b.earned)}/${formatNum(b.available)} (${b.questionCount} questions)</li>`).join("")}
  </ul>
</div>`
    : "";

  return `<!doctype html><html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; color: #0b1c30; line-height: 1.5;">
<h2 style="color: #001e40; margin-bottom: 4px;">Diagnostic results for ${escapeHtml(studentName)}</h2>
<p style="color: #43474f; margin-top: 0;">${formatNum(totalEarned)} of ${formatNum(totalAvailable)} marks.</p>

${bookletBreakdown}

${strongCopy}

${weakHeading}
${weakList}

<p>These insights have been saved to ${escapeHtml(studentName)}'s record — you can open the marked paper to see the AI's question-by-question explanation, or jump straight to assigning focused practice on the weak topics.</p>

<p style="margin-top: 24px;">
  <a href="${reviewUrl}" style="display:inline-block; background:#003366; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:bold;">See the marked paper</a>
  &nbsp;
  <a href="${dashboardUrl}" style="display:inline-block; background:#fff; color:#001e40; border:2px solid #001e40; padding:10px 16px; border-radius:10px; text-decoration:none; font-weight:bold;">Assign focused practice</a>
</p>

${renderTopicChartHtml(topicChart)}

<p style="margin-top: 32px; color: #43474f;">From the MarkForYou Team.</p>
</body></html>`;
}

// CSS-only horizontal bar chart, table-based for email-client
// compatibility (Outlook ignores most flexbox / div tricks). Each row:
// topic name | filled bar (% of marks gained) | "earned/available".
// Bar colour: green ≥75%, amber ≥50%, red below.
function renderTopicChartHtml(rows: { topic: string; earned: number; available: number }[]): string {
  if (rows.length === 0) return "";
  const safeRows = rows.slice(0, 12); // keep the email tidy
  return `<h3 style="margin-top:32px; color:#001e40; font-size:15px;">Topic-by-topic breakdown</h3>
<table style="width:100%; border-collapse:collapse; margin-top:8px; font-size:13px;">
  ${safeRows.map(r => {
    const pct = Math.max(0, Math.min(100, Math.round((r.earned / Math.max(1, r.available)) * 100)));
    const fill = pct >= 75 ? "#006c49" : pct >= 50 ? "#d58d00" : "#ba1a1a";
    return `<tr>
      <td style="padding:5px 8px 5px 0; vertical-align:middle; color:#001e40; width:38%;">${escapeHtml(r.topic)}</td>
      <td style="padding:5px 8px; vertical-align:middle; width:42%;">
        <div style="background:#eef2ff; border-radius:4px; height:8px; overflow:hidden;">
          <div style="background:${fill}; height:8px; width:${pct}%;"></div>
        </div>
      </td>
      <td style="padding:5px 0 5px 8px; vertical-align:middle; text-align:right; color:#43474f; width:20%; white-space:nowrap;">${formatNum(r.earned)} / ${formatNum(r.available)}</td>
    </tr>`;
  }).join("")}
</table>`;
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
