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

The first image is a composite of a printed exam page with the student's handwritten answers overlaid in BLUE INK.

Questions on this page (vertical position as % from top of image):
{QUESTIONS}

{ANSWER_IMAGES_NOTE}

Instructions:
1. For EACH question listed, locate the student's handwritten work within its vertical region.
   - Questions often have PARTS: (a), (b), (c). Match each part's written answer to that part's expected answer.
   - The student writes their final answer in the dedicated answer space (usually bottom-right of the question area, or in a labelled box/line).
   - Working steps may appear above or alongside the final answer.

2. Read the marks available from the printed question label (e.g. "Q3 (3m)", "[2]", "( 2 marks)" etc.).

3. For each question (and each part if the question has parts):
   - Compare the student's FINAL answer for that question/part against the expected answer.
   - If final answer matches → full marks for that question/part.
   - If final answer is wrong but working/method is partially correct → partial marks (proportional to correct steps shown).
   - For diagram/figure questions: compare the student's drawn diagram against the expected answer diagram image (provided as additional image), assessing completeness and accuracy.

4. Sum up marks across all parts to give the total marksAwarded for the question entry.

Return ONLY valid JSON (no markdown fences):
{
  "questions": [
    {
      "questionId": "EXACT_ID_FROM_LIST",
      "marksAvailable": 2,
      "marksAwarded": 1,
      "notes": "Part (a) correct. Part (b): correct method but wrong arithmetic at last step."
    }
  ]
}`;

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
    // Answer pages (from metadata) are excluded from the submission
    const metadata = paper.metadata as {
      answerPages?: number[];
    } | null;
    const answerPageSet = new Set(
      (metadata?.answerPages ?? []).map((p: number) => p - 1)
    );
    const submissionIndexMap = new Map<number, number>(); // originalIdx → submissionIdx
    let submissionIdx = 0;
    for (let i = 0; i < paper.pageCount; i++) {
      if (!answerPageSet.has(i)) {
        submissionIndexMap.set(i, submissionIdx++);
      }
    }

    // Group questions by original page index
    const byPage = new Map<number, typeof paper.questions>();
    for (const q of paper.questions) {
      if (!byPage.has(q.pageIndex)) byPage.set(q.pageIndex, []);
      byPage.get(q.pageIndex)!.push(q);
    }

    const allResults: QuestionMarkResult[] = [];

    for (const [pageIndex, questions] of byPage) {
      const submissionPage = submissionIndexMap.get(pageIndex);
      if (submissionPage === undefined) continue; // answer page — skip

      const pagePath = path.join(subDir, `page_${submissionPage}.jpg`);
      let pageBuffer: Buffer;
      try {
        pageBuffer = await fs.readFile(pagePath);
      } catch {
        continue; // page not submitted
      }
      const pageBase64 = pageBuffer.toString("base64");

      // Build question descriptions
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
          return `- Question ${q.questionNum} (ID: ${q.id}): vertical region ${yStart}–${yEnd} from top. Expected answer: ${answerDesc}`;
        })
        .join("\n");

      // Collect questions that have image answers
      const imageAnswerQuestions = questions.filter((q) => q.answerImageData);
      let answerImagesNote = "";
      if (imageAnswerQuestions.length > 0) {
        answerImagesNote =
          `Additional images (2 onwards) are the expected answer diagrams in this order:\n` +
          imageAnswerQuestions
            .map(
              (q, i) =>
                `- Image ${i + 2}: expected answer diagram for Question ${q.questionNum}`
            )
            .join("\n");
      }

      const prompt = MARKING_PROMPT.replace(
        "{QUESTIONS}",
        questionLines
      ).replace("{ANSWER_IMAGES_NOTE}", answerImagesNote);

      // Build Gemini parts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [
        { inlineData: { mimeType: "image/jpeg" as const, data: pageBase64 } },
      ];

      for (const q of imageAnswerQuestions) {
        if (!q.answerImageData) continue;
        const sepIdx = q.answerImageData.indexOf(";base64,");
        if (sepIdx > 5) {
          const mimeType = q.answerImageData.slice(5, sepIdx); // strip "data:"
          const data = q.answerImageData.slice(sepIdx + 8);    // strip ";base64,"
          parts.push({ inlineData: { mimeType, data } });
        }
      }

      parts.push({ text: prompt });

      const response = await getAI().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      });

      const text = response.text;
      if (!text) continue;

      try {
        const parsed = JSON.parse(text) as { questions: QuestionMarkResult[] };
        allResults.push(...parsed.questions);
      } catch {
        console.warn(`Failed to parse marking response for page ${pageIndex}`);
      }
    }

    // Persist marks per question
    let totalAwarded = 0;
    for (const result of allResults) {
      await prisma.examQuestion.update({
        where: { id: result.questionId },
        data: {
          marksAwarded: result.marksAwarded,
          marksAvailable: result.marksAvailable,
          markingNotes: result.notes,
        },
      });
      totalAwarded += result.marksAwarded ?? 0;
    }

    await prisma.examPaper.update({
      where: { id: paperId },
      data: { score: totalAwarded, markingStatus: "complete" },
    });
  } catch (err) {
    console.error("Marking failed:", err);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { markingStatus: "failed" },
    });
    throw err;
  }
}
