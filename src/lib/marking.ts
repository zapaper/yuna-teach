import path from "path";
import { promises as fs } from "fs";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

// Timeout for each Gemini call (3 minutes — some pages with many diagram answers are slow)
const GEMINI_TIMEOUT_MS = 180_000;

function getAI() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
}

interface QuestionMarkResult {
  questionId: string;
  marksAvailable: number;
  marksAwarded: number;
  studentAnswer?: string;
  notes: string;
}

/** Build markingNotes string, prefixing with detected student answer when available */
function buildMarkingNotes(result: QuestionMarkResult): string {
  const parts: string[] = [];
  if (result.studentAnswer) parts.push(`Detected: ${result.studentAnswer}`);
  if (result.notes) parts.push(result.notes);
  return parts.join(" | ");
}

const MARKING_PROMPT = `You are marking a primary school student's exam submission. Be concise.

HOW TO READ THIS IMAGE:
- Printed question text = BLACK. Student's handwritten answers = BLUE INK.
- Do NOT confuse printed diagrams/text (black) with the student's writing (blue).

Questions on this page (vertical position as % from top of image):
{QUESTIONS}

{ANSWER_IMAGES_NOTE}

Instructions — follow this EXACT sequence for EACH question:

STEP 1: Read the student's answer.
  Find the student's blue-ink answer ONLY within the question's vertical region (yStart%–yEnd%).
  IMPORTANT: Multiple questions may share the same page image. ONLY look at the area between the
  specified yStart% and yEnd% for each question. IGNORE any writing outside those boundaries —
  that belongs to a different question.
  - Questions may have parts (a), (b), (c). Read each part separately.
  - Final answer is usually in the answer box/line at bottom-right of question space.

STEP 2: Marks available.
  Use the "marksAvailable" value specified for each question.
  If it says "detect", read from the printed label on the page (e.g. "[2]", "(2 marks)").

STEP 3: Compare against the expected answer. Follow this priority:
  A) If the student's answer MATCHES the expected answer → FULL MARKS. Done. No further checking needed.
  B) If the student's answer does NOT match:
     - For MCQ (single option answer like "1","2","A","B"): ZERO marks. No partial marks for MCQ.
     - For written/worked answers: check if working/steps are partially correct.
       If some steps are correct → award PARTIAL marks = round(proportion of correct steps × marksAvailable).
       e.g. 2 out of 3 steps correct on a 3-mark question → round(2/3 × 3) = 2 marks.
     - If answer is wrong with no correct working → ZERO marks.
  C) For diagram questions: compare student's blue-ink drawing against the expected answer diagram image.

STEP 4: Record what you detected.
  "studentAnswer": Write EXACTLY what the student wrote/drew in blue ink.
    - For text/number answers: quote their written answer (e.g. "3.5 kg", "B", "12").
    - For MCQ: the option letter/number they circled/wrote (e.g. "1", "2", "3", "4", "A", "B", "C", "D").
      *** CRITICAL — Detecting the answer "1" ***
      A handwritten "1" looks like a SINGLE SHORT VERTICAL STROKE in blue ink. It is the MOST commonly misread MCQ answer.
      - Do NOT dismiss a single vertical blue stroke as a stray mark, scratch, or artifact — it is almost certainly the digit "1".
      - If you see ANY blue ink mark in the answer area that resembles a short vertical line, treat it as the answer "1".
      - "1" is a valid and common MCQ answer. Students frequently choose option (1). Expect to see it.
      - When in doubt between "no answer" and "1", choose "1" — a deliberate stroke of blue ink in the answer area is an answer.
      - Compare: "1" = single vertical stroke | "2" = curved top + horizontal base | "3" = two curves | "4" = angled lines.
      Any blue ink writing in the answer area is the student's answer.
    - If nothing was written: "No answer detected"
    - If multi-part: combine parts (e.g. "(a) 12 (b) 3.5")

STEP 5: Notes — keep SHORT:
  - Full marks → notes = "" (empty string)
  - Partial or zero marks → 1 sentence max explaining what went wrong

Return ONLY valid JSON (no markdown fences):
{
  "questions": [
    {"questionId": "ID", "marksAvailable": 2, "marksAwarded": 2, "studentAnswer": "3.5 kg", "notes": ""},
    {"questionId": "ID", "marksAvailable": 3, "marksAwarded": 1, "studentAnswer": "(a) 12 (b) 7", "notes": "Part (b) arithmetic error in last step."}
  ]
}`;

// Extract JSON from a Gemini response that may have markdown fences or extra text
function extractJson(text: string): unknown {
  // Strip markdown code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  // Find the first { ... } block
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in response");
  return JSON.parse(raw.slice(start, end + 1));
}

// Wrap a promise with a hard timeout that rejects after `ms` milliseconds
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

// Re-mark a single question (e.g. after parent hits "Re-mark")
export async function remarkSingleQuestion(questionId: string): Promise<void> {
  console.log(`[marking] remarkSingleQuestion ${questionId}`);
  const question = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    include: { examPaper: { include: { questions: { select: { marksAwarded: true } } } } },
  });
  if (!question) throw new Error("Question not found");

  const paper = question.examPaper;
  const subDir = path.join(SUBMISSIONS_DIR, paper.id);

  // Compute submissionIndexMap the same way as markExamPaper
  const metadata = paper.metadata as { answerPages?: number[] } | null;
  const answerPageSet = new Set((metadata?.answerPages ?? []).map((p: number) => p - 1));
  let submissionIdx = 0;
  let submissionPage = -1;
  for (let i = 0; i < paper.pageCount; i++) {
    if (!answerPageSet.has(i)) {
      if (i === question.pageIndex) { submissionPage = submissionIdx; break; }
      submissionIdx++;
    }
  }
  if (submissionPage === -1) throw new Error("Question page not in submission");

  const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
  const pageBuffer = await fs.readFile(pagePath);
  const pageBase64 = pageBuffer.toString("base64");

  const yStart = question.yStartPct != null ? `${question.yStartPct.toFixed(1)}%` : "unknown";
  const yEnd = question.yEndPct != null ? `${question.yEndPct.toFixed(1)}%` : "unknown";
  const answerDesc = question.answerImageData
    ? `[diagram — see additional image]${question.answer ? `. Marking guidance: ${question.answer}` : ""}`
    : question.answer ? `"${question.answer}"` : "not provided";
  const marksInfo = question.marksAvailable != null ? `marksAvailable: ${question.marksAvailable}` : `marksAvailable: detect`;
  const questionLines = `- Question ${question.questionNum} (ID: ${question.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}. Expected answer: ${answerDesc}`;

  let answerImagesNote = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [
    { inlineData: { mimeType: "image/jpeg" as const, data: pageBase64 } },
  ];
  if (question.answerImageData) {
    const sepIdx = question.answerImageData.indexOf(";base64,");
    if (sepIdx > 5) {
      answerImagesNote = `Additional image 2: expected answer diagram for Question ${question.questionNum}`;
      parts.push({ inlineData: { mimeType: question.answerImageData.slice(5, sepIdx), data: question.answerImageData.slice(sepIdx + 8) } });
    }
  }

  const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote);
  parts.push({ text: prompt });

  console.log(`[marking] Calling Gemini for remark of question ${questionId}`);
  const response = await withTimeout(
    getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    }),
    GEMINI_TIMEOUT_MS,
    `remark question ${questionId}`
  );

  const text = response.text;
  if (!text) throw new Error("Empty Gemini response");
  const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
  const result = parsed.questions.find((q) => q.questionId === questionId) ?? parsed.questions[0];
  if (!result) throw new Error("No result for question");

  await prisma.examQuestion.update({
    where: { id: questionId },
    data: { marksAwarded: result.marksAwarded, marksAvailable: result.marksAvailable, markingNotes: buildMarkingNotes(result) },
  });

  // Recalculate paper total score
  const allMarks = paper.questions.map((q) =>
    q === question ? (result.marksAwarded ?? 0) : (q.marksAwarded ?? 0)
  );
  const total = allMarks.reduce((a, b) => a + b, 0);
  await prisma.examPaper.update({ where: { id: paper.id }, data: { score: total } });
  console.log(`[marking] remarkSingleQuestion done, new total=${total}`);
}

export async function markExamPaper(paperId: string): Promise<void> {
  console.log(`[marking] Starting markExamPaper for paper ${paperId}`);
  await prisma.examPaper.update({
    where: { id: paperId },
    data: { markingStatus: "in_progress" },
  });

  try {
    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
      include: { questions: { orderBy: { orderIndex: "asc" } } },
    });
    if (!paper) throw new Error("Paper not found");

    // Sync marksAvailable, answer, and answerImageData from master paper
    // so marking uses the latest values the parent set (not stale clone-time copies)
    if (paper.sourceExamId) {
      const master = await prisma.examPaper.findUnique({
        where: { id: paper.sourceExamId },
        include: { questions: { orderBy: { orderIndex: "asc" } } },
      });
      if (master) {
        const masterByNum = new Map(master.questions.map((q) => [q.questionNum, q]));
        for (const q of paper.questions) {
          const mq = masterByNum.get(q.questionNum);
          if (mq) {
            const updates: Record<string, unknown> = {};
            if (mq.marksAvailable !== q.marksAvailable) updates.marksAvailable = mq.marksAvailable;
            if (mq.answer !== q.answer) updates.answer = mq.answer;
            if (mq.answerImageData !== q.answerImageData) updates.answerImageData = mq.answerImageData;
            if (Object.keys(updates).length > 0) {
              await prisma.examQuestion.update({ where: { id: q.id }, data: updates });
              Object.assign(q, updates);
            }
          }
        }
        console.log(`[marking] Synced question data from master ${paper.sourceExamId}`);
      }
    }

    console.log(`[marking] Paper has ${paper.questions.length} questions, pageCount=${paper.pageCount}`);

    const subDir = path.join(SUBMISSIONS_DIR, paperId);

    // Build mapping: original PDF page index → submission file index
    // Answer pages (from metadata) are not included in the submission files
    const metadata = paper.metadata as { answerPages?: number[] } | null;
    const answerPageSet = new Set(
      (metadata?.answerPages ?? []).map((p: number) => p - 1)
    );
    const submissionIndexMap = new Map<number, number>();
    let submissionIdx = 0;
    for (let i = 0; i < paper.pageCount; i++) {
      if (!answerPageSet.has(i)) submissionIndexMap.set(i, submissionIdx++);
    }

    // Group questions by original page index
    const byPage = new Map<number, typeof paper.questions>();
    for (const q of paper.questions) {
      if (!byPage.has(q.pageIndex)) byPage.set(q.pageIndex, []);
      byPage.get(q.pageIndex)!.push(q);
    }

    console.log(`[marking] Marking ${byPage.size} page(s) concurrently`);

    // ── Mark all pages CONCURRENTLY ──────────────────────────────────────────
    const pageEntries = [...byPage.entries()];

    const pageResults = await Promise.all(
      pageEntries.map(async ([pageIndex, questions]) => {
        const submissionPage = submissionIndexMap.get(pageIndex);
        if (submissionPage === undefined) {
          console.log(`[marking] Page ${pageIndex} is an answer page — skipping`);
          return []; // answer page — skip
        }

        const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
        let pageBuffer: Buffer;
        try {
          pageBuffer = await fs.readFile(pagePath);
        } catch {
          console.warn(`[marking] Submission file not found for page ${pageIndex} (submission page ${submissionPage})`);
          return []; // page not submitted
        }
        const pageBase64 = pageBuffer.toString("base64");
        console.log(`[marking] Calling Gemini for pageIndex=${pageIndex} (${questions.length} questions, file size ${pageBuffer.length} bytes)`);

        // Build question descriptions for prompt
        const questionLines = questions
          .map((q) => {
            const yStart =
              q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown";
            const yEnd =
              q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown";
            const answerDesc = q.answerImageData
              ? `[diagram — see additional image]${q.answer ? `. Marking guidance: ${q.answer}` : ""}`
              : q.answer
              ? `"${q.answer}"`
              : "not provided";
            const marksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
            return `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}. Expected answer: ${answerDesc}`;
          })
          .join("\n");

        // Collect questions with image (diagram) answers
        const imageAnswerQuestions = questions.filter((q) => q.answerImageData);
        let answerImagesNote = "";
        if (imageAnswerQuestions.length > 0) {
          answerImagesNote =
            `Additional images (2 onwards) are expected answer diagrams:\n` +
            imageAnswerQuestions
              .map(
                (q, i) =>
                  `- Image ${i + 2}: expected answer for Question ${q.questionNum}`
              )
              .join("\n");
        }

        const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace(
          "{ANSWER_IMAGES_NOTE}",
          answerImagesNote
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts: any[] = [
          { inlineData: { mimeType: "image/jpeg" as const, data: pageBase64 } },
        ];
        for (const q of imageAnswerQuestions) {
          if (!q.answerImageData) continue;
          const sepIdx = q.answerImageData.indexOf(";base64,");
          if (sepIdx > 5) {
            const mimeType = q.answerImageData.slice(5, sepIdx);
            const data = q.answerImageData.slice(sepIdx + 8);
            parts.push({ inlineData: { mimeType, data } });
          }
        }
        parts.push({ text: prompt });

        try {
          const response = await withTimeout(
            getAI().models.generateContent({
              model: "gemini-2.5-flash",
              contents: [{ role: "user", parts }],
              config: { responseMimeType: "application/json", temperature: 0.1 },
            }),
            GEMINI_TIMEOUT_MS,
            `page ${pageIndex}`
          );
          const text = response.text;
          if (!text) {
            console.warn(`[marking] Empty Gemini response for page ${pageIndex}`);
            return [];
          }
          const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
          console.log(`[marking] Page ${pageIndex} done — ${parsed.questions.length} results`);
          return parsed.questions;
        } catch (err) {
          console.warn(`[marking] Failed for page ${pageIndex}:`, err);
          return [];
        }
      })
    );

    let allResults = pageResults.flat();
    console.log(`[marking] All pages done. Total results: ${allResults.length}`);

    // ── Retry pass: re-mark questions that got no result ─────────────────────
    const markedIds = new Set(allResults.map((r) => r.questionId));
    const unmarkedQuestions = paper.questions.filter((q) => !markedIds.has(q.id));
    if (unmarkedQuestions.length > 0) {
      console.log(`[marking] ${unmarkedQuestions.length} questions got no result — retrying individually`);
      const retryResults = await Promise.all(
        unmarkedQuestions.map(async (q) => {
          const submissionPage = submissionIndexMap.get(q.pageIndex);
          if (submissionPage === undefined) return null;
          const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
          let pageBuffer: Buffer;
          try {
            pageBuffer = await fs.readFile(pagePath);
          } catch {
            return null;
          }
          const pageBase64 = pageBuffer.toString("base64");
          const yStart = q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown";
          const yEnd = q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown";
          const answerDesc = q.answerImageData
            ? `[diagram — see additional image]${q.answer ? `. Marking guidance: ${q.answer}` : ""}`
            : q.answer ? `"${q.answer}"` : "not provided";
          const retryMarksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
          const questionLines = `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${retryMarksInfo}. Expected answer: ${answerDesc}`;

          let answerImagesNote = "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parts: any[] = [
            { inlineData: { mimeType: "image/jpeg" as const, data: pageBase64 } },
          ];
          if (q.answerImageData) {
            const sepIdx = q.answerImageData.indexOf(";base64,");
            if (sepIdx > 5) {
              answerImagesNote = `Additional image 2: expected answer diagram for Question ${q.questionNum}`;
              parts.push({ inlineData: { mimeType: q.answerImageData.slice(5, sepIdx), data: q.answerImageData.slice(sepIdx + 8) } });
            }
          }
          const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote);
          parts.push({ text: prompt });

          try {
            console.log(`[marking] Retry for Q${q.questionNum} (${q.id})`);
            const response = await withTimeout(
              getAI().models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts }],
                config: { responseMimeType: "application/json", temperature: 0.1 },
              }),
              GEMINI_TIMEOUT_MS,
              `retry Q${q.questionNum}`
            );
            const text = response.text;
            if (!text) return null;
            const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
            const result = parsed.questions.find((r) => r.questionId === q.id) ?? parsed.questions[0];
            if (result) {
              // Ensure the questionId is correct
              result.questionId = q.id;
              console.log(`[marking] Retry Q${q.questionNum} succeeded: ${result.marksAwarded}/${result.marksAvailable}`);
              return result;
            }
            return null;
          } catch (err) {
            console.warn(`[marking] Retry failed for Q${q.questionNum}:`, err);
            return null;
          }
        })
      );
      for (const r of retryResults) {
        if (r) allResults.push(r);
      }
      const stillUnmarked = paper.questions.length - allResults.length;
      if (stillUnmarked > 0) {
        console.warn(`[marking] ${stillUnmarked} questions still unmarked after retry`);
      }
    }

    // ── Verification pass: re-mark questions that lost marks ─────────────────
    const validIds = new Set(paper.questions.map((q) => q.id));
    const resultMap = new Map<string, QuestionMarkResult>();
    for (const r of allResults) {
      if (validIds.has(r.questionId) && !resultMap.has(r.questionId)) {
        resultMap.set(r.questionId, r);
      }
    }

    const questionsToVerify = paper.questions.filter((q) => {
      const r = resultMap.get(q.id);
      if (!r) return false;
      return r.marksAwarded < r.marksAvailable;
    });

    if (questionsToVerify.length > 0) {
      console.log(`[marking] Verification pass: ${questionsToVerify.length} questions with partial/zero marks — re-marking`);

      const verifyResults = await Promise.all(
        questionsToVerify.map(async (q) => {
          const submissionPage = submissionIndexMap.get(q.pageIndex);
          if (submissionPage === undefined) return null;
          const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
          let pageBuffer: Buffer;
          try {
            pageBuffer = await fs.readFile(pagePath);
          } catch {
            return null;
          }
          const pageBase64 = pageBuffer.toString("base64");
          const yStart = q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown";
          const yEnd = q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown";
          const answerDesc = q.answerImageData
            ? `[diagram — see additional image]${q.answer ? `. Marking guidance: ${q.answer}` : ""}`
            : q.answer ? `"${q.answer}"` : "not provided";
          const marksInfo = q.marksAvailable != null ? `marksAvailable: ${q.marksAvailable}` : `marksAvailable: detect`;
          const questionLines = `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. ${marksInfo}. Expected answer: ${answerDesc}`;

          let answerImagesNote = "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parts: any[] = [
            { inlineData: { mimeType: "image/jpeg" as const, data: pageBase64 } },
          ];
          if (q.answerImageData) {
            const sepIdx = q.answerImageData.indexOf(";base64,");
            if (sepIdx > 5) {
              answerImagesNote = `Additional image 2: expected answer diagram for Question ${q.questionNum}`;
              parts.push({ inlineData: { mimeType: q.answerImageData.slice(5, sepIdx), data: q.answerImageData.slice(sepIdx + 8) } });
            }
          }
          const prompt = MARKING_PROMPT.replace("{QUESTIONS}", questionLines).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote);
          parts.push({ text: prompt });

          try {
            const orig = resultMap.get(q.id)!;
            console.log(`[marking] Verify Q${q.questionNum} (${q.id}) — original: ${orig.marksAwarded}/${orig.marksAvailable}`);
            const response = await withTimeout(
              getAI().models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts }],
                config: { responseMimeType: "application/json", temperature: 0.1 },
              }),
              GEMINI_TIMEOUT_MS,
              `verify Q${q.questionNum}`
            );
            const text = response.text;
            if (!text) return null;
            const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
            const result = parsed.questions.find((r) => r.questionId === q.id) ?? parsed.questions[0];
            if (result) {
              result.questionId = q.id;
              return result;
            }
            return null;
          } catch (err) {
            console.warn(`[marking] Verify failed for Q${q.questionNum}:`, err);
            return null;
          }
        })
      );

      let upgraded = 0;
      for (const vr of verifyResults) {
        if (!vr) continue;
        const original = resultMap.get(vr.questionId);
        if (!original) continue;
        if (vr.marksAwarded > original.marksAwarded) {
          console.log(`[marking] Verify UPGRADE Q${vr.questionId}: ${original.marksAwarded} → ${vr.marksAwarded}/${original.marksAvailable}`);
          const idx = allResults.findIndex((r) => r.questionId === vr.questionId);
          if (idx !== -1) allResults[idx] = vr;
          upgraded++;
        } else {
          console.log(`[marking] Verify KEPT original for Q${vr.questionId}: verify=${vr.marksAwarded}, original=${original.marksAwarded}`);
        }
      }
      console.log(`[marking] Verification complete: ${upgraded}/${questionsToVerify.length} questions upgraded`);
    }

    // ── Batch DB updates in a single transaction ──────────────────────────────
    // Filter to only valid question IDs (Gemini sometimes hallucinates extra IDs)
    const validResults = new Map<string, QuestionMarkResult>();
    for (const result of allResults) {
      if (validIds.has(result.questionId) && !validResults.has(result.questionId)) {
        validResults.set(result.questionId, result);
      }
    }

    const discarded = allResults.length - validResults.size;
    if (discarded > 0) {
      console.warn(`[marking] Discarded ${discarded} results with invalid/duplicate question IDs`);
    }
    console.log(`[marking] Updating ${validResults.size}/${paper.questions.length} questions`);

    // Build a lookup of pre-set marksAvailable from DB
    const presetMarks = new Map(paper.questions.map(q => [q.id, q.marksAvailable]));

    let totalAwarded = 0;
    const questionUpdates = [...validResults.values()].map((result) => {
      totalAwarded += result.marksAwarded ?? 0;
      // Keep pre-set marksAvailable if it exists; otherwise use Gemini's detected value
      const existingMarks = presetMarks.get(result.questionId);
      return prisma.examQuestion.update({
        where: { id: result.questionId },
        data: {
          marksAwarded: result.marksAwarded,
          marksAvailable: existingMarks ?? result.marksAvailable,
          markingNotes: buildMarkingNotes(result),
        },
      });
    });

    await prisma.$transaction([
      ...questionUpdates,
      prisma.examPaper.update({
        where: { id: paperId },
        data: { score: totalAwarded, markingStatus: "complete" },
      }),
    ]);
    // Validate marks total
    if (paper.totalMarks) {
      const expectedTotal = parseFloat(paper.totalMarks);
      const actualAvailable = [...validResults.values()].reduce(
        (s, r) => s + ((presetMarks.get(r.questionId) ?? r.marksAvailable) ?? 0), 0
      );
      if (!isNaN(expectedTotal) && Math.abs(actualAvailable - expectedTotal) > 0.5) {
        console.warn(`[marking] Marks validation: sum of marksAvailable (${actualAvailable}) != paper totalMarks (${expectedTotal})`);
      }
    }
    console.log(`[marking] Paper ${paperId} marked complete. Score: ${totalAwarded}`);
  } catch (err) {
    console.error(`[marking] markExamPaper failed for ${paperId}:`, err);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "failed" },
    });
    throw err;
  }
}

// ── On-demand feedback summary generation ─────────────────────────────────

export async function generateFeedbackSummary(paperId: string): Promise<string> {
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    include: { questions: true },
  });
  if (!paper) throw new Error("Paper not found");

  const questions = paper.questions;
  const totalAwarded = questions.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
  const totalMarksNum = paper.totalMarks ? parseFloat(paper.totalMarks) : null;

  // Compute per-booklet scores from metadata
  const metaPapers = (paper.metadata as { papers?: Array<{ label: string; questionPrefix: string }> })?.papers ?? [];
  const bookletScores: Array<{ label: string; awarded: number; available: number }> = [];

  if (metaPapers.length > 1) {
    for (const mp of metaPapers) {
      let awarded = 0;
      let available = 0;
      for (const q of questions) {
        const matchesPrefix = mp.questionPrefix === ""
          ? !metaPapers.some(other => other.questionPrefix !== "" && q.questionNum.startsWith(other.questionPrefix))
          : q.questionNum.startsWith(mp.questionPrefix);
        if (matchesPrefix) {
          awarded += q.marksAwarded ?? 0;
          available += q.marksAvailable ?? 0;
        }
      }
      bookletScores.push({ label: mp.label, awarded, available });
    }
  }

  // Build mistakes list with question details
  const mistakes = questions
    .filter(q => q.marksAwarded !== null && q.marksAvailable !== null && q.marksAwarded < q.marksAvailable)
    .map(q => {
      const lost = (q.marksAvailable ?? 0) - (q.marksAwarded ?? 0);
      return `Q${q.questionNum}: Lost ${lost} mark(s). Answer: ${q.answer ?? "N/A"}. ${q.markingNotes ?? ""}`;
    });

  const feedbackPrompt = `You are writing a short feedback summary for a primary school student's exam, aimed at helping them know what to revise.

Paper: ${paper.title}
Subject: ${paper.subject ?? "Unknown"}
Level: ${paper.level ?? "Unknown"}
Score: ${totalAwarded}${totalMarksNum ? ` out of ${totalMarksNum}` : ""}
${bookletScores.length > 1 ? `\nPer-section scores:\n${bookletScores.map(b => `- ${b.label}: ${b.awarded}/${b.available}`).join("\n")}` : ""}
${mistakes.length > 0 ? `\nQuestions with marks lost:\n${mistakes.join("\n")}` : "\nNo mistakes — full marks!"}

Write a feedback summary with:
1. An encouraging opening sentence mentioning the score (e.g. "Well done! You scored 42 out of 50!")
2. ${bookletScores.length > 1 ? "Briefly mention per-section scores." : ""}
3. If there are mistakes, identify the SPECIFIC TOPICS or CONCEPTS the student should revise. Group related mistakes together. Use phrases like "You may wish to revise your notes on [topic]." Be specific — e.g. "angles and trigonometry", "vocabulary on food and drinks", "fractions and decimals", "grammar — past tense".
4. End with an encouraging note.

Keep the tone warm, positive, and age-appropriate for a primary school child. Total length: 3-6 sentences. Do NOT use markdown formatting. Plain text only.`;

  const feedbackResponse = await withTimeout(
    getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: feedbackPrompt }] }],
      config: { temperature: 0.7 },
    }),
    30_000,
    "feedback summary"
  );
  const feedbackText = feedbackResponse.text?.trim() ?? "";

  if (feedbackText) {
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { feedbackSummary: feedbackText },
    });
  }

  return feedbackText;
}

// ── Focused test marking (handwritten answers, one submission page per question) ─

const FOCUSED_MARKING_PROMPT = `You are marking a primary school student's handwritten answer for a math question. Be concise.

HOW TO READ THE IMAGES:
- Image 1: The printed question.
- Image 2: The student's handwritten answer (blue ink on white paper).
{ANSWER_IMAGE_NOTE}

Expected answer: {EXPECTED_ANSWER}
Marks available: {MARKS_AVAILABLE}

Instructions:
1. Read the student's blue-ink handwritten answer from Image 2.
2. Compare against the expected answer.
   - If correct → FULL MARKS.
   - For written/worked answers: check if working/steps are partially correct → award PARTIAL marks.
   - If wrong with no correct working → ZERO marks.
   - For MCQ (single option answer): no partial marks.
3. Record what you detected.

Return ONLY valid JSON (no markdown fences):
{"questionId": "{QUESTION_ID}", "marksAvailable": {MARKS_AVAILABLE}, "marksAwarded": <number>, "studentAnswer": "<what the student wrote>", "notes": "<brief 1-sentence explanation or empty if full marks>"}`;

export async function markFocusedTest(paperId: string): Promise<void> {
  console.log(`[focused-marking] Starting for ${paperId}`);

  try {
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "in_progress" },
    });

    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
      include: { questions: { orderBy: { orderIndex: "asc" } } },
    });
    if (!paper) throw new Error("Paper not found");

    const subDir = path.join(SUBMISSIONS_DIR, paperId);
    const ai = getAI();
    let totalAwarded = 0;
    const updates = [];

    for (let i = 0; i < paper.questions.length; i++) {
      const q = paper.questions[i];
      const expectedAnswer = q.answer || "?";
      const marksAvailable = q.marksAvailable ?? 1;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];

      // Image 1: question image (from DB)
      if (q.imageData && q.imageData.startsWith("data:image")) {
        const match = q.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          parts.push({ text: "Image 1 — The question:" });
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }

      // Image 2: student's handwritten answer (from submission files)
      let hasSubmission = false;
      try {
        const pagePath = path.join(subDir, `page_${i}.jpg`);
        const pageBuffer = await fs.readFile(pagePath);
        parts.push({ text: "Image 2 — Student's handwritten answer:" });
        parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: pageBuffer.toString("base64") } });
        hasSubmission = true;
      } catch {
        // No submission image for this question
      }

      // Add expected answer image if available
      let answerImageNote = "";
      if (q.answerImageData && q.answerImageData.startsWith("data:image")) {
        const match = q.answerImageData.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          parts.push({ text: "Expected answer image (for reference):" });
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          answerImageNote = "An additional image showing the expected answer is also provided.";
        }
      }

      // Build prompt
      const prompt = FOCUSED_MARKING_PROMPT
        .replace("{EXPECTED_ANSWER}", `"${expectedAnswer}"`)
        .replace(/\{MARKS_AVAILABLE\}/g, String(marksAvailable))
        .replace("{QUESTION_ID}", q.id)
        .replace("{ANSWER_IMAGE_NOTE}", answerImageNote);

      parts.push({ text: prompt });

      if (!hasSubmission) {
        // No answer submitted for this question
        updates.push(
          prisma.examQuestion.update({
            where: { id: q.id },
            data: { marksAwarded: 0, markingNotes: "No answer submitted" },
          })
        );
        continue;
      }

      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts }],
            config: { temperature: 0.1 },
          }),
          GEMINI_TIMEOUT_MS,
          `focused-q${q.questionNum}`
        );

        const text = response.text?.trim() ?? "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as QuestionMarkResult;
          const awarded = Math.min(
            marksAvailable,
            Math.max(0, Number(parsed.marksAwarded) || 0)
          );
          totalAwarded += awarded;
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: {
                marksAwarded: awarded,
                markingNotes: buildMarkingNotes({ ...parsed, questionId: q.id, marksAvailable, marksAwarded: awarded }),
              },
            })
          );
        } else {
          updates.push(
            prisma.examQuestion.update({
              where: { id: q.id },
              data: { marksAwarded: 0, markingNotes: "Failed to parse AI response" },
            })
          );
        }
      } catch (err) {
        console.error(`[focused-marking] Q${q.questionNum} failed:`, err);
        updates.push(
          prisma.examQuestion.update({
            where: { id: q.id },
            data: { marksAwarded: 0, markingNotes: "Marking error" },
          })
        );
      }
    }

    // Batch update
    await prisma.$transaction([
      ...updates,
      prisma.examPaper.update({
        where: { id: paperId },
        data: { score: totalAwarded, markingStatus: "complete" },
      }),
    ]);

    // Generate feedback
    await generateFeedbackSummary(paperId);

    console.log(`[focused-marking] Paper ${paperId} done. Score: ${totalAwarded}`);
  } catch (err) {
    console.error(`[focused-marking] Failed for ${paperId}:`, err);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "failed" },
    });
  }
}
