import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import fs from "fs";
import path from "path";

const VOLUME_PATH = process.env.VOLUME_PATH || "/data";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pageIndices, sectionName } = await request.json() as {
    pageIndices: number[];
    sectionName: string; // e.g. "Vocabulary Cloze MCQ"
  };

  if (!pageIndices?.length || !sectionName) {
    return NextResponse.json({ error: "pageIndices and sectionName required" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    include: { questions: { orderBy: { orderIndex: "asc" } } },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  // Load page images from disk
  const pagesDir = path.join(VOLUME_PATH, "pages", id);
  const imagesBase64: string[] = [];
  for (const pageIdx of pageIndices) {
    const filePath = path.join(pagesDir, `page_${pageIdx}.jpg`);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: `Page ${pageIdx} not found on disk` }, { status: 404 });
    }
    const buf = fs.readFileSync(filePath);
    imagesBase64.push(buf.toString("base64"));
  }

  const secLabel = sectionName;
  const isMcqSection = secLabel.toLowerCase().includes("mcq");

  // Step 1: OCR the pages
  const ocrParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  for (let pi = 0; pi < imagesBase64.length; pi++) {
    ocrParts.push({ inlineData: { mimeType: "image/jpeg" as const, data: imagesBase64[pi] } });
    if (imagesBase64.length > 1) ocrParts.push({ text: `(image ${pi + 1} of ${imagesBase64.length})` });
  }

  ocrParts.push({ text: `Extract ALL text from these exam paper pages as RICH TEXT. Preserve formatting:
- Keep question numbers exactly as printed (e.g. "1.", "11.", "(29)")
- Keep answer options exactly (e.g. "(1) option text", "(2) option text")
- Keep blank lines as "___" (underscore line where student writes)
- PARAGRAPH INDENTATION: When the original text shows a NEW PARAGRAPH (indented first line), start that line with exactly 4 spaces.
- Preserve PARAGRAPH SPACING: use ONE blank line between paragraphs.
- Do NOT include page break markers, page numbers, or page indicators
- For Vocabulary Cloze MCQ: each question has an UNDERLINED WORD in the passage. The word is printed in a visually different way (underlined, bold, or italic) from the surrounding text. Mark the question number and the underlined word inline: "... word **(16) __underlinedWord__** word ..." — the __double underscores__ render as underlined text in the UI. The MCQ options are shown separately below each question.
- If the Vocabulary Cloze has a BLANK instead of an underlined word, use: "... word **(16)________** word ..."
- Exclude page headers/footers like "Score", "Please do not write in the margins", page numbers, section titles, school name, exam title.
Output ONLY the clean passage/question text, no commentary.` });

  console.log(`[Re-extract] ${secLabel}: OCR ${imagesBase64.length} page(s)`);

  const ocrResponse = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: ocrParts }],
    config: { temperature: 0.1 },
  }, 2, 5000, `reextract-ocr:${secLabel}`);

  const ocrText = ocrResponse.text?.trim() ?? "";
  console.log(`[Re-extract] ${secLabel}: OCR result (${ocrText.length} chars)`);

  // Step 1b: For sections with passages (vocab cloze, grammar cloze, editing, comp cloze),
  // also extract the passage as a separate passageOcrText
  const isVocabCloze = secLabel.toLowerCase().includes("vocab") && secLabel.toLowerCase().includes("cloze");
  const needsPassage = isVocabCloze
    || (secLabel.toLowerCase().includes("grammar") && secLabel.toLowerCase().includes("cloze"))
    || secLabel.toLowerCase().includes("editing")
    || (secLabel.toLowerCase().includes("comprehension") && secLabel.toLowerCase().includes("cloze"));

  let passageOcrText = "";
  if (needsPassage && ocrText) {
    // The ocrText already contains the full passage + questions.
    // For vocab cloze: passage is the prose with blanks, questions are the MCQ options below.
    // Store the full ocrText as the passage since it includes inline markers.
    passageOcrText = ocrText;
  }

  // Find existing questions for this section to get question range
  const sectionQs = paper.questions.filter(q =>
    (q.syllabusTopic ?? "").toLowerCase().replace(/\s+/g, "") === secLabel.toLowerCase().replace(/\s+/g, "")
  );
  const qNums = sectionQs.map(q => parseInt(q.questionNum)).filter(n => !isNaN(n));
  const secFirstQ = qNums.length > 0 ? Math.min(...qNums) : 1;
  const secLastQ = qNums.length > 0 ? Math.max(...qNums) : secFirstQ + 4;

  // Step 2: Extract individual questions from OCR text
  const extractPrompt = `You are extracting individual questions from an English exam paper. The text below was OCR'd from the exam pages.

Section: ${secLabel}
Expected questions: Q${secFirstQ} to Q${secLastQ} (${secLastQ - secFirstQ + 1} questions)

TEXT:
${ocrText}

For EACH question, extract:
- questionNum: the question number as string (e.g. "${secFirstQ}")
- stem: the full question text. If the OCR text wraps across multiple lines, JOIN them into one sentence.${secLabel.toLowerCase().includes("vocabulary cloze") ? `
  For Vocabulary Cloze MCQ: the stem MUST include the sentence from the passage that contains the underlined/highlighted word.
  In the passage, each question has a WORD that is UNDERLINED (printed differently from surrounding text). The student must choose the closest meaning from 4 options.
  Use __double underscores__ around the underlined word: "The boy was __elated__ when he saw the gift."
  If there is a blank instead of an underlined word, use "________" (8 underscores): "The boy was ________ when he saw the gift."
  The OCR text marks underlined words as **(...) __word__** — extract just the sentence containing that word.` : ""}${isMcqSection ? `
- options: array of EXACTLY 4 option strings ["option1", "option2", "option3", "option4"]. Extract the text of each option WITHOUT the numbering "(1)", "(2)", etc.` : ""}
- syllabusTopic: "${secLabel}"

Return ONLY valid JSON:
{
  "questions": [
    ${isMcqSection
      ? `{"questionNum": "${secFirstQ}", "stem": "<question text>", "options": ["<opt1>", "<opt2>", "<opt3>", "<opt4>"], "syllabusTopic": "${secLabel}"}`
      : `{"questionNum": "${secFirstQ}", "stem": "<question text>", "syllabusTopic": "${secLabel}"}`
    }
  ]
}`;

  const extractResponse = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: extractPrompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  }, 2, 5000, `reextract-questions:${secLabel}`);

  const extractText = extractResponse.text?.trim() ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let extractedQuestions: any[] = [];
  try {
    const cleaned = extractText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    extractedQuestions = parsed.questions ?? parsed;
  } catch (err) {
    console.error(`[Re-extract] JSON parse failed:`, err);
    return NextResponse.json({ error: "Failed to parse AI response" }, { status: 500 });
  }

  console.log(`[Re-extract] ${secLabel}: extracted ${extractedQuestions.length} questions`);

  // Step 3: Update existing questions with new data
  let updated = 0;
  for (const eq of extractedQuestions) {
    const qNum = String(eq.questionNum);
    const existing = sectionQs.find(q => q.questionNum === qNum);
    if (!existing) continue;

    const updateData: Record<string, unknown> = {};
    if (eq.stem) updateData.transcribedStem = eq.stem;
    if (eq.options && Array.isArray(eq.options)) updateData.transcribedOptions = eq.options;

    if (Object.keys(updateData).length > 0) {
      await prisma.examQuestion.update({
        where: { id: existing.id },
        data: updateData,
      });
      updated++;
    }
  }

  // Step 4: Update sectionOcrTexts metadata
  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const allOcr = (meta.sectionOcrTexts ?? {}) as Record<string, Record<string, unknown>>;
  const secKey = Object.keys(allOcr).find(k =>
    k.toLowerCase().replace(/\s+/g, "") === secLabel.toLowerCase().replace(/\s+/g, "")
  ) ?? secLabel;
  allOcr[secKey] = {
    ...(allOcr[secKey] ?? {}),
    ocrText,
    pageIndices,
    ...(passageOcrText ? { passageOcrText } : {}),
  };
  await prisma.examPaper.update({
    where: { id },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: { ...meta, sectionOcrTexts: allOcr } as any },
  });

  return NextResponse.json({
    ocrText,
    questionsUpdated: updated,
    questionsExtracted: extractedQuestions.length,
  });
}
