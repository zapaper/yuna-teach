import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _ai;
}

// POST /api/exam/[id]/elaborate
// Body: { questionId }
// Returns: { elaboration: string }
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { questionId } = await request.json();

  if (!questionId) {
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
  }

  const question = await prisma.examQuestion.findFirst({
    where: { id: questionId, examPaperId: id },
    select: {
      questionNum: true,
      answer: true,
      marksAvailable: true,
      marksAwarded: true,
      markingNotes: true,
      imageData: true,
      diagramImageData: true,
      studentAnswer: true,
      elaboration: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedSubparts: true,
      syllabusTopic: true,
      sourceQuestionId: true,
      examPaper: { select: { paperType: true, metadata: true } },
    },
  });

  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  // Return cached elaboration if available
  if (question.elaboration) {
    return NextResponse.json({ elaboration: question.elaboration });
  }

  const isQuiz = question.examPaper?.paperType === "quiz";
  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];

  // For cloze/editing questions without stems, still use the quiz path for passage context
  const topicLower = (question.syllabusTopic ?? "").toLowerCase();
  const isClozeOrEditing = topicLower.includes("cloze") || topicLower.includes("editing");
  if (isQuiz && (question.transcribedStem || isClozeOrEditing)) {
    // For quiz questions, use clean transcribed text to avoid Gemini reading school/year from exam paper header
    const opts = question.transcribedOptions as string[] | null;
    const subs = question.transcribedSubparts as { label: string; text: string }[] | null;
    let questionText = question.transcribedStem ?? `Question ${question.questionNum}`;
    if (opts && opts.length > 0) {
      questionText += "\n" + opts.map((o, i) => `(${i + 1}) ${o}`).join("\n");
    }
    if (subs && subs.length > 0) {
      questionText += "\n" + subs.filter(s => s.label !== "_drawable").map(s => `(${s.label}) ${s.text}`).join("\n");
    }

    // For Visual Text MCQ: include the visual text passage OCR for context
    let visualTextContext = "";
    const isVisualText = (question.syllabusTopic ?? "").toLowerCase().includes("visual") &&
      (question.syllabusTopic ?? "").toLowerCase().includes("text");
    if (isVisualText && question.sourceQuestionId) {
      try {
        // Get source paper's sectionOcrTexts for Visual Text passage
        const sourceQ = await prisma.examQuestion.findUnique({
          where: { id: question.sourceQuestionId },
          select: { examPaperId: true },
        });
        if (sourceQ) {
          const sourcePaper = await prisma.examPaper.findUnique({
            where: { id: sourceQ.examPaperId },
            select: { metadata: true },
          });
          const meta = sourcePaper?.metadata as { sectionOcrTexts?: Record<string, { ocrText: string }> } | null;
          if (meta?.sectionOcrTexts) {
            for (const [secName, secData] of Object.entries(meta.sectionOcrTexts)) {
              if (secName.toLowerCase().includes("visual") && secName.toLowerCase().includes("text")) {
                visualTextContext = secData.ocrText;
                break;
              }
            }
          }
        }
      } catch { /* non-critical */ }
    }

    // Include diagram image only (cropped, no headers)
    if (question.diagramImageData) {
      const match = question.diagramImageData.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    // For Visual Text: also send the question image (contains the flyer/poster)
    if (isVisualText && question.imageData) {
      const match = question.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }

    const visualTextNote = visualTextContext
      ? `\n\nHere is the visual text (flyer/poster/advertisement) that the question refers to:\n${visualTextContext}\n`
      : "";

    // For Grammar Cloze / Editing: include the passage text for context
    let passageContext = "";
    const topic = (question.syllabusTopic ?? "").toLowerCase();
    const isGrammarCloze = topic.includes("grammar") && topic.includes("cloze");
    const isEditing = topic.includes("editing");
    const isCompCloze = topic.includes("comprehension") && topic.includes("cloze");
    const isCompOeq = (topic.includes("comprehension") && (topic.includes("open") || topic.includes("oeq")));
    if ((isGrammarCloze || isEditing || isCompCloze || isCompOeq) && question.examPaper?.metadata) {
      const paperMeta = question.examPaper.metadata as { englishSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> };
      if (paperMeta.englishSections) {
        const qIdx = parseInt(question.questionNum) - 1; // 0-based
        const sec = paperMeta.englishSections.find(s => qIdx >= s.startIndex && qIdx <= s.endIndex);
        if (sec?.passage && !sec.passage.startsWith("[")) {
          passageContext = sec.passage;
        }
      }
    }
    if (isGrammarCloze || isEditing || isCompCloze) {
      console.log(`[Elaborate] Q${question.questionNum} topic="${question.syllabusTopic}" passageContext=${passageContext ? `${passageContext.length} chars` : "EMPTY"}`);
      if (!passageContext) {
        const paperMeta2 = question.examPaper?.metadata as { englishSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> } | null;
        console.log(`[Elaborate] englishSections=${paperMeta2?.englishSections ? paperMeta2.englishSections.map(s => `${s.label}[${s.startIndex}-${s.endIndex}] passage=${s.passage ? s.passage.length + "ch" : "none"}`).join(", ") : "none"}`);
        console.log(`[Elaborate] qIdx=${parseInt(question.questionNum) - 1}`);
      }
    }
    const passageNote = passageContext
      ? `\n\nHere is the FULL passage that this question is based on:\n${passageContext}\n\n${isCompOeq ? "Use the passage to explain the answer to this comprehension question." : `Focus on blank (${question.questionNum}) in the passage above. Look at the surrounding sentences to explain the answer.`}\n`
      : "";
    // For synthesis: combine keyword with student's typed answer
    const isSynthesis = topic.includes("synthesis");
    let studentAnswerNote = "";
    if (isSynthesis && question.studentAnswer) {
      const kwMatch = (question.transcribedStem ?? "").match(/\*\*([^*]+)\*\*/);
      const kw = kwMatch ? kwMatch[1].trim() : "";
      let fullAnswer = question.studentAnswer;
      if (kw) {
        if (question.studentAnswer.includes("|||")) {
          const [before, after] = question.studentAnswer.split("|||");
          fullAnswer = `${before.trim()} ${kw} ${after.trim()}`.trim();
        } else {
          fullAnswer = `${kw} ${question.studentAnswer}`.trim();
        }
      }
      studentAnswerNote = `\nStudent's answer: "${fullAnswer}"`;
    } else if (question.studentAnswer) {
      studentAnswerNote = `\nStudent's answer: "${question.studentAnswer}"`;
    }

    const sectionHint = isGrammarCloze
      ? " This is a Grammar Cloze question — the student must choose the correct word from a word bank (identified by letter A-Q) to fill in the blank in the passage. Explain why the correct word fits the blank based on grammar and meaning."
      : isEditing
        ? " This is an Editing question — the student must identify and correct the spelling/grammar error in the underlined word. Explain the correct spelling/grammar rule."
        : isCompCloze
          ? ` This is a Comprehension Cloze question for a 10-12 year old student. They must fill in blank (${question.questionNum}) with a suitable word.

Use simple, child-friendly language. Quote the sentence with the blank from the passage. Explain in 2-3 short sentences why the correct word fits — focus on meaning and grammar clues in the surrounding words.

If the student gave an answer, explain why it is wrong OR if you believe their answer could also be accepted (fits the meaning and grammar), say so clearly: "Your answer could also be accepted because..."`
          : isSynthesis
            ? " This is a Synthesis & Transformation question — the student must rewrite the sentence using the given word while keeping the same meaning. Explain what the correct answer should be and why, comparing it with the student's answer."
            : isCompOeq
              ? " This is a Comprehension OEQ question based on the reading passage above. Quote relevant parts of the passage and explain how to arrive at the correct answer."
              : isVisualText
              ? " Reference the visual text content to explain why the answer is correct."
              : "";

    parts.push({
      text: `You are a helpful tutor for a primary/secondary school student.

Here is the question:
${questionText}
${visualTextNote}${passageNote}
Correct answer: ${question.answer ?? "Not provided"}${studentAnswerNote}

Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it. Do NOT discuss what the student did wrong or why they lost marks — just teach the correct approach.${sectionHint}

Keep the explanation concise (under 200 words), age-appropriate, and encouraging. Use simple language. Write all math in plain text (e.g. "3/7" not "\\frac{3}{7}", "x^2" not "x²" in LaTeX). Do not use LaTeX or any special math notation. Use **double asterisks** to bold step labels (e.g. **Step 1:**), the answer label (**Answer:**), and key subject terms (e.g. **numerator**, **photosynthesis**). No other markdown.`,
    });
  } else {
    // For regular exam papers, use the raw question image
    if (question.imageData) {
      const match = question.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    parts.push({
      text: `You are a helpful tutor for a primary/secondary school student.

Here is an exam question the student needs help with.

Question number: ${question.questionNum}
Correct answer: ${question.answer ?? "Not provided"}

Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it. Do NOT discuss what the student did wrong or why they lost marks — just teach the correct approach.

Keep the explanation concise (under 200 words), age-appropriate, and encouraging. Use simple language. Write all math in plain text (e.g. "3/7" not "\\frac{3}{7}", "x^2" not "x²" in LaTeX). Do not use LaTeX or any special math notation. Use **double asterisks** to bold step labels (e.g. **Step 1:**), the answer label (**Answer:**), and key subject terms (e.g. **numerator**, **photosynthesis**). No other markdown. If the question image is provided, reference the actual question content.`,
    });
  }

  try {
    const response = await getAI().models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts }],
    });

    const elaboration = response.text ?? "Unable to generate explanation.";

    // Cache the elaboration in the database
    await prisma.examQuestion.update({
      where: { id: questionId },
      data: { elaboration },
    });

    return NextResponse.json({ elaboration });
  } catch (err) {
    console.error("Elaboration failed:", err);
    return NextResponse.json(
      { error: "Failed to generate elaboration" },
      { status: 500 }
    );
  }
}
