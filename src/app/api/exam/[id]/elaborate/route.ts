import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";
import { mathHeuristicsBlock } from "@/lib/math-heuristics";
import { isSessionAdmin } from "@/lib/session";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _ai;
}

type DiagramRow = { label: string; units: number; value: string | null };
type DiagramStep = { title: string | null; rows: DiagramRow[]; unitValue: string | null };

// Shared rule block for the AI prompt — mirrors the solver's
// `diagrams` schema so the same BarDiagram component renders both.
// Kept as a constant so the quiz/exam prompts don't drift apart.
const COMMON_DIAGRAM_RULES = `When a fraction-of-fraction word problem, ratio problem, before-vs-after comparison, or any question where a visual breakdown would help, also return a "diagrams" array using the Singapore model method:
[{
  "title": "<e.g. 'Step 1: Initial ratio' or null for single-step>",
  "rows": [{ "label": "<name or quantity>", "units": <integer 1-12>, "value": "<known value, '?' if unknown, or null>" }],
  "unitValue": "<value of 1 unit if determinable, else null>"
}]
Rules:
- Use multi-step ONLY if the problem changes state (e.g. 'After …'). Most questions need exactly one diagram.
- Each row = one labelled bar. units = the integer count (e.g. ratio 3:5 → units 3 and 5).
- value = the actual quantity if known/solved, "?" if asked for, null if not relevant.
- Optionally add a Total row.
- Maximum 5 rows per step. units must be 1–12.
- Only emit a diagram when it actually adds clarity. For straightforward arithmetic, return "diagrams": [].

Respond with ONLY valid JSON (no markdown fences, no surrounding text):
{
  "solution": "<step-by-step text with **bold** as described above>",
  "diagrams": [...]
}`;

// Wraps a possibly-JSON-encoded cached value into the API response
// shape. Old rows pre-date the JSON shape and are stored as plain
// text; treat those as solution-only with no diagrams.
function parseCachedElaboration(cached: string): { elaboration: string; diagrams: DiagramStep[] } {
  try {
    const parsed = JSON.parse(cached) as { solution?: unknown; diagrams?: unknown };
    if (parsed && typeof parsed.solution === "string") {
      const diagrams = Array.isArray(parsed.diagrams) ? (parsed.diagrams as DiagramStep[]) : [];
      return { elaboration: parsed.solution, diagrams };
    }
  } catch { /* not JSON — fall through */ }
  return { elaboration: cached, diagrams: [] };
}

// Detect the bulk-route's failure sentinel — a JSON object with
// __elabError but no `solution` field. The per-card route treats
// these as cache misses so a manual retry from the quiz player
// re-attempts generation instead of returning the error string.
function isErrorSentinel(cached: string | null | undefined): boolean {
  if (!cached) return false;
  if (!cached.startsWith('{"__elabError"')) return false;
  try {
    const parsed = JSON.parse(cached) as { __elabError?: unknown; solution?: unknown };
    return typeof parsed.__elabError === "string" && typeof parsed.solution !== "string";
  } catch { return false; }
}

// Extract {solution, diagrams} from Gemini's text response. Strips
// markdown fences if present (the model sometimes wraps despite the
// prompt asking for none).
function parseModelResponse(text: string): { solution: string; diagrams: DiagramStep[] } {
  let raw = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1].trim();
  try {
    const parsed = JSON.parse(raw) as { solution?: unknown; diagrams?: unknown };
    if (parsed && typeof parsed.solution === "string") {
      const diagrams = Array.isArray(parsed.diagrams) ? (parsed.diagrams as DiagramStep[]) : [];
      return { solution: parsed.solution, diagrams };
    }
  } catch { /* not JSON — treat the whole thing as plain solution text */ }
  return { solution: text, diagrams: [] };
}

// PATCH /api/exam/[id]/elaborate
// Body: { questionId, solution: string, diagrams?: DiagramStep[] }
// Admin-only — overwrites the cached AI explanation for one question
// with hand-edited text. Stored in the same {solution, diagrams} JSON
// shape that the AI-generation path writes, so the read path
// (parseCachedElaboration / parseElabCache) needs no changes.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  let body: { questionId?: unknown; solution?: unknown; diagrams?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }
  if (typeof body.questionId !== "string" || typeof body.solution !== "string") {
    return NextResponse.json({ error: "questionId and solution required" }, { status: 400 });
  }
  const diagrams = Array.isArray(body.diagrams) ? body.diagrams : [];
  // Confirm the question belongs to this paper before touching it.
  const q = await prisma.examQuestion.findFirst({
    where: { id: body.questionId, examPaperId: id },
    select: { id: true, sourceQuestionId: true },
  });
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });
  const payload = JSON.stringify({ solution: body.solution, diagrams });
  await prisma.examQuestion.update({
    where: { id: q.id },
    data: { elaboration: payload },
  });
  // If this is a clone of a master question, mirror the edit onto the
  // master too so future clones (and the master's own review page)
  // pick up the curated text instead of re-generating from scratch.
  if (q.sourceQuestionId) {
    await prisma.examQuestion.update({
      where: { id: q.sourceQuestionId },
      data: { elaboration: payload },
    }).catch(() => { /* master may not exist if extraction was deleted */ });
  }
  return NextResponse.json({ ok: true });
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
      transcribedOptionImages: true,
      transcribedSubparts: true,
      syllabusTopic: true,
      sourceQuestionId: true,
      examPaper: { select: { paperType: true, metadata: true, subject: true } },
    },
  });

  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  // Comp Cloze: never cache — explanation is specific to student's answer
  const isCompClozeQuestion = (question.syllabusTopic ?? "").toLowerCase().includes("comprehension") &&
    (question.syllabusTopic ?? "").toLowerCase().includes("cloze");

  // MCQ detection — same rules as elsewhere in the codebase. The
  // master question is the canonical home for an MCQ explanation:
  // every clone of the same master MCQ has the identical question
  // text, options, and answer key, so the explanation can be
  // shared. We always check the master first and only call the
  // model on a true cache miss.
  const opts = question.transcribedOptions as unknown[] | null;
  const optImgs = question.transcribedOptionImages as unknown[] | null;
  const ansLetter = (question.answer ?? "").trim().replace(/[().]/g, "");
  const isMcq =
    (Array.isArray(opts) && opts.length === 4) ||
    (Array.isArray(optImgs) && optImgs.some((o) => !!o)) ||
    ansLetter === "1" || ansLetter === "2" || ansLetter === "3" || ansLetter === "4";

  // Return cached elaboration if available (except Comp Cloze).
  // Cached value may be the new JSON shape ({solution, diagrams}) or
  // the legacy plain-text shape — fall through to plain text on parse
  // failure so old rows still render. The bulk route's error
  // sentinel ({"__elabError":...}) is treated as a cache miss so a
  // manual retry re-attempts generation.
  if (question.elaboration && !isCompClozeQuestion && !isErrorSentinel(question.elaboration)) {
    return NextResponse.json(parseCachedElaboration(question.elaboration));
  }

  // For MCQ — and for Math/Science OEQ — the explanation is a fresh
  // step-by-step solution that doesn't depend on the student's
  // specific answer (marking notes already cover what they got
  // wrong). So clones can share the master's cached elaboration. We
  // exclude English OEQ because synthesis/comp/cloze explanations
  // often quote the student's answer back, which differs per clone.
  const subjectLower = (question.examPaper?.subject ?? "").toLowerCase();
  const isMathOrScience = subjectLower.includes("math") || subjectLower.includes("science");
  const canShareMasterElab = (isMcq || isMathOrScience) && !isCompClozeQuestion;
  if (canShareMasterElab && question.sourceQuestionId) {
    const master = await prisma.examQuestion.findUnique({
      where: { id: question.sourceQuestionId },
      select: { elaboration: true },
    });
    if (master?.elaboration && !isErrorSentinel(master.elaboration)) {
      await prisma.examQuestion.update({
        where: { id: questionId },
        data: { elaboration: master.elaboration },
      });
      return NextResponse.json(parseCachedElaboration(master.elaboration));
    }
  }

  // Was gated on isQuiz (paperType in {quiz, focused}). That gate
  // caused English Grammar MCQ master questions on library papers
  // (paperType=null) to be elaborated with image-only context —
  // Gemini had no question text, hallucinated a generic "Step 1:
  // identify key values, Step 2: equation, Step 3: match" math
  // template, and that bogus output got cached on the master and
  // inherited by every mastery clone. Now: whenever a transcribed
  // stem (or cloze/editing topic) is available, use the clean-text
  // prompt regardless of paperType.
  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];

  // Subject-specific format for the "solution" string.
  // Science: bullet points — Science explanations are usually a
  //   short concept chain (cause → effect → conclusion) rather than
  //   a procedural calculation, and the "Step N:" framing feels
  //   over-engineered.
  // Math / English / other: keep the existing numbered "Step 1: /
  //   Step 2: / Answer:" format.
  // (subjectLower is declared earlier near the master-clone check.)
  const isScienceSubject = subjectLower.includes("science");
  const formatStyleRule = isScienceSubject
    ? `Format the explanation as a SHORT bulleted list — start each line with "- " (hyphen + space). Do NOT use "Step 1:" / "Step 2:" / numbered step labels. End with a final bullet that starts with "**Answer:**". Use **double asterisks** to bold the answer label and key scientific terms within each bullet. No other markdown.`
    : `Use **double asterisks** to bold step labels (**Step 1:**, **Answer:**) and key words inside each step (the operation, the value being computed, "**1 unit**", subject terms). No other markdown.`;

  // For cloze/editing questions without stems, still use the quiz path for passage context
  const topicLower = (question.syllabusTopic ?? "").toLowerCase();
  const isClozeOrEditing = topicLower.includes("cloze") || topicLower.includes("editing");
  if (question.transcribedStem || isClozeOrEditing) {
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

    // For Grammar Cloze / Editing: include the passage text for context.
    // Chinese 阅读理解 / 短文填空 / 完成对话 questions ALSO get passage
    // context — the metadata key is `chineseSections` instead of
    // `englishSections`, same shape.
    let passageContext = "";
    const topic = (question.syllabusTopic ?? "").toLowerCase();
    const rawTopic = question.syllabusTopic ?? "";
    const isGrammarCloze = topic.includes("grammar") && topic.includes("cloze");
    const isEditing = topic.includes("editing");
    const isCompCloze = topic.includes("comprehension") && topic.includes("cloze");
    const isCompOeq = (topic.includes("comprehension") && (topic.includes("open") || topic.includes("oeq")));
    const isChinesePaper = subjectLower.includes("chinese") || subjectLower.includes("华文") || subjectLower.includes("中文");
    const isChineseCompMcq = rawTopic.includes("阅读理解 MCQ") || rawTopic.includes("阅读理解 mcq");
    const isChineseCompOeq = rawTopic.includes("阅读理解 OEQ") || rawTopic.includes("阅读理解 oeq");
    const isChineseVocabCloze = rawTopic.includes("短文填空");
    const isChineseDialogue = rawTopic.includes("完成对话") || rawTopic.includes("对话填空");
    const needsPassage = isGrammarCloze || isEditing || isCompCloze || isCompOeq || isChineseCompMcq || isChineseCompOeq || isChineseVocabCloze || isChineseDialogue;
    if (needsPassage && question.examPaper?.metadata) {
      const paperMeta = question.examPaper.metadata as {
        englishSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }>;
        chineseSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }>;
      };
      const allSecs = [...(paperMeta.englishSections ?? []), ...(paperMeta.chineseSections ?? [])];
      const qIdx = parseInt(question.questionNum) - 1; // 0-based
      const sec = allSecs.find(s => qIdx >= s.startIndex && qIdx <= s.endIndex);
      if (sec?.passage && !sec.passage.startsWith("[")) {
        passageContext = sec.passage;
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
      ? isChinesePaper
        ? `\n\n以下是这道题对应的整段短文：\n${passageContext}\n\n${isChineseCompMcq || isChineseCompOeq ? "请根据短文内容解释答案。" : isChineseVocabCloze ? `请聚焦于短文中的空格（第 ${question.questionNum} 题），从前后文判断哪个选项最合适。` : isChineseDialogue ? `请聚焦于对话中的空格（第 ${question.questionNum} 题），从上下文判断哪一项最合适。` : "请利用短文内容解释答案。"}\n`
        : `\n\nHere is the FULL passage that this question is based on:\n${passageContext}\n\n${isCompOeq ? "Use the passage to explain the answer to this comprehension question." : `Focus on blank (${question.questionNum}) in the passage above. Look at the surrounding sentences to explain the answer.`}\n`
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
          ? ` This is a Comprehension Cloze question (blank ${question.questionNum}). Be very concise — max 3 sentences. Quote the key phrase around the blank, then state why the correct word fits. **Bold** the key reason (e.g. grammar rule, meaning clue). If the student's answer is wrong, state in one sentence why it doesn't fit. If their answer could be accepted, say so briefly.`
          : isSynthesis
            ? " This is a Synthesis & Transformation question — the student must rewrite the sentence using the given word while keeping the same meaning. Explain what the correct answer should be and why, comparing it with the student's answer."
            : isCompOeq
              ? " This is a Comprehension OEQ question based on the reading passage above. Quote relevant parts of the passage and explain how to arrive at the correct answer."
              : isVisualText
              ? " Reference the visual text content to explain why the answer is correct."
              : "";

    const hasDiagramHere = !!question.diagramImageData;
    const answerAnchor = isChinesePaper
      ? `**正确答案是：${question.answer ?? "未提供"}** — 这是官方参考答案，须以此为准。${hasDiagramHere ? "若题目含有图示，可能不易精确辨认；遇到分歧时以参考答案为准，并据此倒推合理解释。" : ""} 你的解释必须最终落到此答案。如果你的推理指向其他选项，那是你看错了题目，请重新阅读并解释如何得出参考答案。`
      : `**The answer is ${question.answer ?? "Not provided"} — this is the official answer key and is authoritative.**${hasDiagramHere ? " The question contains a diagram which may be hard to read precisely from the image alone — when in doubt, trust the answer key over your reading of the diagram and work backwards to justify it." : ""} Your explanation MUST arrive at this answer. If your working seems to point at a different answer, you have misread the question or diagram — re-examine and explain how the official answer is reached.`;
    parts.push({
      text: isChinesePaper ? `你是一位耐心的华文老师，正在帮一位小学生理解这道题。

题目：
${questionText}
${visualTextNote}${passageNote}
${answerAnchor}${studentAnswerNote}

请直接给出正确答案，然后用简单清楚的简体中文，按步骤解释为什么这是正确答案。不要讨论学生哪里错了，也不要列出失分原因——只教正确思路。${sectionHint}

"solution" 字段的内容必须用简体中文，控制在 150 字以内，语气友好、简单易懂。可以用 **双星号** 标出关键词或步骤标签 (例如 **关键词:**、**答案:**)。${isChineseCompMcq || isChineseCompOeq ? " 引用短文里相关的语句来支持你的解释。" : ""}${isChineseVocabCloze ? " 请说明所选选项为什么最贴合空格前后的语境，其他选项为什么不行。" : ""}${isChineseDialogue ? " 请说明所选短语为什么最适合对话情境。" : ""} 数字、(1)/(2)/(3)/(4) 等选项标号保持原样。不要使用任何 LaTeX 或英文公式语法。

${COMMON_DIAGRAM_RULES.replace(/^When a fraction[\s\S]*?return "diagrams": \[\]\./, "Chinese 阅读 / 词语题不需要画图，请直接返回 \"diagrams\": [].")}` : `You are a helpful tutor for a primary/secondary school student.

Here is the question:
${questionText}
${visualTextNote}${passageNote}
${answerAnchor}${studentAnswerNote}

Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it. Do NOT discuss what the student did wrong or why they lost marks — just teach the correct approach.${sectionHint}

Keep the "solution" tight: aim for 120 words, hard cap at 150. Age-appropriate, encouraging, simple language. **Fractions MUST be written as inline LaTeX delimited by single dollar signs**. CRITICAL — your output is JSON, so backslashes inside string values MUST be DOUBLED: write \`$\\\\frac{3}{7}$\` (with TWO backslashes) inside the "solution" string, not \`$\\frac{3}{7}$\`. The JSON parser will turn the doubled backslash back into one. Same for mixed numbers: \`$3\\\\frac{1}{2}$\`. If you forget to double the backslash, JSON parsing will eat \`\\f\` as a form-feed and the fraction breaks. Other math stays plain text: x or * for multiply, ÷ for divide, x^2 for powers, = for equals. The only LaTeX command allowed is \\\\frac. ${formatStyleRule}

For Singapore-primary fraction or ratio word problems where the question gives one fraction of one quantity and another fraction of a *remainder* (e.g. "1/4 of total were X", "2/5 of the remaining were Y"), prefer the **units / model method** rather than algebra: pick a **common number of units** that makes both fractions whole, then express each part of the question in those units. Convert one known quantity into "1 unit = …" then read off the answer. This mirrors the answer-key format teachers use.
${mathHeuristicsBlock(question.examPaper?.subject)}

${COMMON_DIAGRAM_RULES}`,
    });
  } else {
    // For regular exam papers, use the raw question image
    if (question.imageData) {
      const match = question.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    const answerAnchor2 = `**The answer is ${question.answer ?? "Not provided"} — this is the official answer key and is authoritative.** The image you're shown may include diagrams that are hard to read precisely — when in doubt, trust the answer key over your reading of the image and work backwards to justify it. Your explanation MUST arrive at this answer. If your working seems to point at a different answer, you have misread the question or diagram — re-examine and explain how the official answer is reached.`;
    parts.push({
      text: `You are a helpful tutor for a primary/secondary school student.

Here is an exam question the student needs help with.

Question number: ${question.questionNum}
${answerAnchor2}

Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it. Do NOT discuss what the student did wrong or why they lost marks — just teach the correct approach.

Keep the "solution" tight: aim for 120 words, hard cap at 150. Age-appropriate, encouraging, simple language. **Fractions MUST be written as inline LaTeX delimited by single dollar signs**. CRITICAL — your output is JSON, so backslashes inside string values MUST be DOUBLED: write \`$\\\\frac{3}{7}$\` (with TWO backslashes) inside the "solution" string, not \`$\\frac{3}{7}$\`. The JSON parser will turn the doubled backslash back into one. Same for mixed numbers: \`$3\\\\frac{1}{2}$\`. If you forget to double the backslash, JSON parsing will eat \`\\f\` as a form-feed and the fraction breaks. Other math stays plain text: x or * for multiply, ÷ for divide, x^2 for powers, = for equals. The only LaTeX command allowed is \\\\frac. ${formatStyleRule}

For Singapore-primary fraction or ratio word problems where the question gives one fraction of one quantity and another fraction of a *remainder*, prefer the **units / model method** rather than algebra: pick a **common number of units** that makes both fractions whole, express each part in those units, then convert via "1 unit = …" to read off the answer.
${mathHeuristicsBlock(question.examPaper?.subject)}

${COMMON_DIAGRAM_RULES}

If the question image is provided, reference the actual question content.`,
    });
  }

  try {
    const response = await getAI().models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts }],
    });

    const raw = response.text ?? "";
    const { solution, diagrams } = parseModelResponse(raw);
    const elaboration = solution || "Unable to generate explanation.";

    // Cache the FULL JSON shape so the next view returns diagrams
    // too without re-prompting. Comp-Cloze stays uncached because
    // the explanation is student-specific.
    if (!isCompClozeQuestion) {
      const cached = JSON.stringify({ solution: elaboration, diagrams });
      await prisma.examQuestion.update({
        where: { id: questionId },
        data: { elaboration: cached },
      });
      // For MCQ — and for Math/Science OEQ — also write to the master
      // so every other clone of the same source question inherits the
      // explanation without re-paying the model. Mirrors the read-side
      // canShareMasterElab gate above. Best-effort — the clone copy
      // is still authoritative for this request.
      if (canShareMasterElab && question.sourceQuestionId) {
        try {
          await prisma.examQuestion.update({
            where: { id: question.sourceQuestionId },
            data: { elaboration: cached },
          });
        } catch (e) {
          console.warn(`[elaborate] master backfill failed for ${question.sourceQuestionId}:`, e);
        }
      }
    }

    return NextResponse.json({ elaboration, diagrams });
  } catch (err) {
    console.error("Elaboration failed:", err);
    return NextResponse.json(
      { error: "Failed to generate elaboration" },
      { status: 500 }
    );
  }
}
