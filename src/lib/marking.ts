import path from "path";
import { promises as fs } from "fs";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

function getAI() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
}

interface QuestionMarkResult {
  questionId: string;
  marksAvailable: number;
  marksAwarded: number;
  notes: string;
}

const MARKING_PROMPT = `You are marking a primary school student's exam submission.

IMPORTANT — HOW TO READ THIS IMAGE:
- The printed question text is in BLACK (this is the original exam paper).
- The student's handwritten answers are in BLUE INK overlaid on top.
- Everything written in blue is the student's work: final answers, working steps, diagrams drawn by the student.
- Do NOT confuse printed diagrams/text (black) with the student's writing (blue).

Questions on this page (vertical position as % from top of image):
{QUESTIONS}

{ANSWER_IMAGES_NOTE}

Instructions:
1. For EACH question, find the student's blue-ink handwriting within its vertical region.
   - Questions often have PARTS: (a), (b), (c). Match each part's blue-ink answer to that part's expected answer.
   - The final answer is typically written in the answer box/line at the bottom-right of the question space.
   - Working steps in blue ink appear above or beside the final answer.

2. Read the marks available from the PRINTED (black) question label (e.g. "Q3 (3m)", "[2]", "(2 marks)").

3. For each question/part:
   - If the student's blue-ink final answer matches the expected answer → full marks.
   - If the final answer is wrong but blue-ink working shows correct method → partial marks based on correct steps shown vs total steps.
   - For diagram questions: compare the student's blue-ink drawing against the expected answer diagram (provided as extra image), assessing accuracy and completeness.

4. Sum marks across all parts to get total marksAwarded for the question.

Return ONLY valid JSON (no markdown fences):
{
  "questions": [
    {
      "questionId": "EXACT_ID_FROM_LIST",
      "marksAvailable": 2,
      "marksAwarded": 1,
      "notes": "Part (a) correct. Part (b): method correct but arithmetic error at last step."
    }
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

// Re-mark a single question (e.g. after parent hits "Re-mark")
export async function remarkSingleQuestion(questionId: string): Promise<void> {
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
    ? `[diagram — see additional image]`
    : question.answer ? `"${question.answer}"` : "not provided";
  const questionLines = `- Question ${question.questionNum} (ID: ${question.id}): vertical region ${yStart}–${yEnd}. Expected answer: ${answerDesc}`;

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

  const response = await getAI().models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  });

  const text = response.text;
  if (!text) throw new Error("Empty Gemini response");
  const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
  const result = parsed.questions.find((q) => q.questionId === questionId) ?? parsed.questions[0];
  if (!result) throw new Error("No result for question");

  await prisma.examQuestion.update({
    where: { id: questionId },
    data: { marksAwarded: result.marksAwarded, marksAvailable: result.marksAvailable, markingNotes: result.notes },
  });

  // Recalculate paper total score
  const allMarks = paper.questions.map((q) =>
    q === question ? (result.marksAwarded ?? 0) : (q.marksAwarded ?? 0)
  );
  const total = allMarks.reduce((a, b) => a + b, 0);
  await prisma.examPaper.update({ where: { id: paper.id }, data: { score: total } });
}

export async function markExamPaper(paperId: string): Promise<void> {
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

    // ── Mark all pages CONCURRENTLY ──────────────────────────────────────────
    const pageEntries = [...byPage.entries()];

    const pageResults = await Promise.all(
      pageEntries.map(async ([pageIndex, questions]) => {
        const submissionPage = submissionIndexMap.get(pageIndex);
        if (submissionPage === undefined) return []; // answer page — skip

        const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
        let pageBuffer: Buffer;
        try {
          pageBuffer = await fs.readFile(pagePath);
        } catch {
          return []; // page not submitted
        }
        const pageBase64 = pageBuffer.toString("base64");

        // Build question descriptions for prompt
        const questionLines = questions
          .map((q) => {
            const yStart =
              q.yStartPct != null ? `${q.yStartPct.toFixed(1)}%` : "unknown";
            const yEnd =
              q.yEndPct != null ? `${q.yEndPct.toFixed(1)}%` : "unknown";
            const answerDesc = q.answerImageData
              ? `[diagram — see additional image]`
              : q.answer
              ? `"${q.answer}"`
              : "not provided";
            return `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd}. Expected answer: ${answerDesc}`;
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
          const response = await getAI().models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts }],
            config: { responseMimeType: "application/json", temperature: 0.1 },
          });
          const text = response.text;
          if (!text) return [];
          const parsed = extractJson(text) as { questions: QuestionMarkResult[] };
          return parsed.questions;
        } catch (err) {
          console.warn(`Marking failed for page ${pageIndex}:`, err);
          return [];
        }
      })
    );

    const allResults = pageResults.flat();

    // ── Batch DB updates in a single transaction ──────────────────────────────
    let totalAwarded = 0;
    const questionUpdates = allResults.map((result) => {
      totalAwarded += result.marksAwarded ?? 0;
      return prisma.examQuestion.update({
        where: { id: result.questionId },
        data: {
          marksAwarded: result.marksAwarded,
          marksAvailable: result.marksAvailable,
          markingNotes: result.notes,
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
  } catch (err) {
    console.error("Marking failed:", err);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "failed" },
    });
    throw err;
  }
}
