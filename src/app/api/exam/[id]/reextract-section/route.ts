import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateContentWithRetry, cleanVocabClozePassageOcr } from "@/lib/gemini";
import { buildChineseSections, type OcrEntry } from "@/lib/extraction";
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

  // Match the main extraction pipeline: pro-first across all subjects.
  // Originally flash-first for speed, then Chinese flipped because
  // 2.5-flash makes transcription errors on Chinese characters. All
  // subjects now use pro-first — accuracy gain outweighs latency for
  // a one-time re-extract; flash stays at the end as last resort.
  //
  // 语文应用 MCQ (Chinese §1) uses 3.1-pro-preview as primary
  // because 2.5-pro was still missing the emphasised tested phrase
  // on character-level detail. Per-section re-extract has to match
  // the main pipeline or fixing one section would still regenerate
  // the same errors.
  const isChinese = (paper.subject ?? "").toLowerCase().includes("chinese");
  const isLangAppMcq = isChinese && (sectionName.includes("语文应用") || sectionName.includes("语文运用"));
  // 完成对话 (word-bank dialogue cloze) — detect Chinese names AND
  // English aliases. When true we run a specialised OCR + extract
  // pipeline and canonicalise both the section key AND every
  // question's syllabusTopic to "完成对话".
  const sectionNameNorm = sectionName.toLowerCase().replace(/\s+/g, "");
  const isDialogueCompletion = isChinese && (
    sectionName.includes("完成对话") ||
    sectionName.includes("对话填空") ||
    sectionNameNorm.includes("dialoguecompletion") ||
    sectionNameNorm.includes("completedialogue") ||
    sectionNameNorm.includes("dialoguecloze")
  );
  const CANONICAL_DIALOGUE_LABEL = "完成对话";
  const MODELS = isLangAppMcq
    ? (["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"] as const)
    : (["gemini-2.5-pro", "gemini-3.1-pro-preview", "gemini-2.5-flash"] as const);

  // Walk the model chain manually; generateContentWithRetry only
  // covers retries for a single model, not chain-fallback.
  async function callWithChain(
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
    label: string,
    config: Record<string, unknown> = { temperature: 0.1 },
  ) {
    let lastErr: unknown = null;
    for (let mi = 0; mi < MODELS.length; mi++) {
      const model = MODELS[mi];
      try {
        const r = await generateContentWithRetry({
          model,
          contents: [{ role: "user", parts }],
          config,
        }, isChinese ? 0 : 2, 3000, `${label}:${model}`);
        if (mi > 0) console.log(`[Re-extract] ${label}: succeeded on fallback ${model}`);
        return r;
      } catch (err) {
        lastErr = err;
        console.warn(`[Re-extract] ${label} on ${model} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw lastErr ?? new Error(`${label}: all models failed`);
  }

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

  ocrParts.push({ text: isDialogueCompletion ? `这是一份新加坡小学华文 (PSLE) 试卷的【完成对话】部分。

这一部分包含两个核心元素：
1. **词语表** — 一个有编号的表格，列出 8 个短语或短句 (编号 1 到 8)。学生从中挑选合适的选项。
2. **对话** — 由 2–3 个角色之间的对话，含有 4 个编号的空格 (通常是 Q26–Q29)。

【词语表布局——重要】
原文的词语表可能是以下两种之一:
  布局 A (横排, 较新的试卷): 1 行表头 "1 2 3 4 5 6 7 8" + 1 行选项文字。
  布局 B (竖排, 较旧的试卷, 例如 2019 / 2020): 8 行键值对, 每行 "| N | 文字 |", 没有表头行。
不管原文是哪一种布局, **你都必须以下面的横排格式输出**, 这是为了下游程序统一处理:

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|
| <选项 1 文字> | <选项 2 文字> | <选项 3 文字> | <选项 4 文字> | <选项 5 文字> | <选项 6 文字> | <选项 7 文字> | <选项 8 文字> |

请提取这部分并按以下精确格式输出 Markdown：

四 完成对话 (4 题 8 分)
根据上下文的意思，从表中选出适当的短语或短句，然后把代表它们的数字填写在作答簿上。

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|
| <选项 1 文字> | ... | <选项 8 文字> |

爸爸: <对话第一句>
小明: <含有空格的对话句子, 空格写成 ______> 我们就参加这项比赛好吗？
爸爸: 我都这把年纪了，______ 。
...

【极重要的规则】
- 词语表无论原文是横排还是竖排, 一律输出成上面的 1×8 横排 markdown 表格。
- 每个空格必须写成精确的 6 个连续下划线: **______** (不要写成 "Q26"、"(26)"、"[空]"、其他符号或表情)。
- 每段对话保留发言人标识 (例: 爸爸:、妈妈:、老师:、小华:、爷爷:)。每一行只能有一个发言人。
- 一句对话最多一个空格。
- 不要加任何编号 (例如 Q26) 在对话里 — 编号只对应空格位置, 自动从对话顺序得出。
- 不要加多余说明、页眉、页脚、页码。
- 输出只包括上述 markdown 文本, 不要被三个反引号围住。` : `Extract ALL text from these exam paper pages as RICH TEXT. Preserve formatting:
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

  console.log(`[Re-extract] ${secLabel}: OCR ${imagesBase64.length} page(s) — model chain: ${MODELS.join(" → ")}`);

  const ocrResponse = await callWithChain(ocrParts, `reextract-ocr:${secLabel}`);

  let ocrText = ocrResponse.text?.trim() ?? "";
  console.log(`[Re-extract] ${secLabel}: OCR result (${ocrText.length} chars)`);
  // Vocab Cloze passage: strip leading instruction header + trailing
  // Q&A block so only the passage reaches the quiz UI.
  if (secLabel.toLowerCase().includes("vocab") && secLabel.toLowerCase().includes("cloze")) {
    const beforeLen = ocrText.length;
    ocrText = cleanVocabClozePassageOcr(ocrText);
    if (ocrText.length !== beforeLen) {
      console.log(`[Re-extract] ${secLabel}: cleaned vocab-cloze passage (${beforeLen} → ${ocrText.length} chars)`);
    }
  }

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

  // Find existing questions for this section to get question range.
  // For 完成对话 we accept BOTH the Chinese canonical label AND any
  // English alias the previous extraction may have set — the section
  // boundary is the same content even when the label string differs.
  const sectionQs = paper.questions.filter(q => {
    const t = (q.syllabusTopic ?? "").toLowerCase().replace(/\s+/g, "");
    if (t === secLabel.toLowerCase().replace(/\s+/g, "")) return true;
    if (isDialogueCompletion) {
      return t === "完成对话" || t === "对话填空" ||
        t.includes("dialoguecompletion") || t.includes("completedialogue");
    }
    return false;
  });
  const qNums = sectionQs.map(q => parseInt(q.questionNum)).filter(n => !isNaN(n));
  const secFirstQ = qNums.length > 0 ? Math.min(...qNums) : 1;
  const secLastQ = qNums.length > 0 ? Math.max(...qNums) : secFirstQ + 4;

  // Step 2: Extract individual questions from OCR text.
  // 完成对话 has its OWN extraction prompt: each question's stem is
  // the speaker line containing that question's blank, with the
  // ______ marker preserved.
  const extractPrompt = isDialogueCompletion ? `你正从一份新加坡小学华文 (PSLE)【完成对话】部分提取题目。OCR 文本如下，它包含 (1) 一个 8 项词语表的 markdown 表格，和 (2) 一段含有 ${secLastQ - secFirstQ + 1} 个空格 (用 \`______\` 表示) 的对话。

期望题目编号: Q${secFirstQ} 到 Q${secLastQ}

OCR 文本:
${ocrText}

【任务】把对话拆分到每一个空格对应的题目。一个空格 = 一题。题目顺序对应空格在对话中出现的顺序 (从上到下)。

【每题输出】
- questionNum: 字符串, e.g. "${secFirstQ}"。从 ${secFirstQ} 开始按对话中空格出现顺序递增。
- stem: 包含该题空格的完整发言人对话行 (保留发言人标识例如 "爸爸:"、"老师:"、"小华:")。空格写成 \`______\` (6 个下划线), 不要写成 "Q26" 或 "(26)"。
- syllabusTopic: 必须为 "${CANONICAL_DIALOGUE_LABEL}"。

【极重要】
- 一题一个空格。不要把多个空格放在同一个 stem。
- stem 必须保留发言人标识。例如: "爸爸: 我们就参加这项比赛好吗？______" 或 "老师: 乐文, ______ 怎么了？"。
- 中文字符、全角标点照旧。

返回纯 JSON, 不要 markdown 包围:
{
  "questions": [
    {"questionNum": "${secFirstQ}", "stem": "<含 ______ 的发言行>", "syllabusTopic": "${CANONICAL_DIALOGUE_LABEL}"},
    {"questionNum": "${secFirstQ + 1}", "stem": "<...>", "syllabusTopic": "${CANONICAL_DIALOGUE_LABEL}"}
  ]
}` : `You are extracting individual questions from an English exam paper. The text below was OCR'd from the exam pages.

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
  The OCR text marks underlined words as **(...) __word__** — extract just the sentence containing that word.` : ""}${secLabel.toLowerCase().includes("synthesis") ? `
  For Synthesis & Transformation: the stem MUST contain TWO things in order:
    1. The original printed source sentence(s) the student is rewriting (the line above the answer area). NEVER omit this — even if the OCR only shows the source sentence on the line above, you must copy it into the stem.
    2. A blank line, then the answer area template with **bold keyword** + ____________________ underscores (one or two lines).
  Full example stem (use this exact shape):
  "John drew a picture of his dog. Then he framed it up.\\n\\n**Instead of** ________________________________\\n________________________________"
  If the source sentence is missing from the OCR, leave a placeholder like "[source sentence]" rather than silently dropping it. Bold the keyword/joining word with **double asterisks**.` : ""}${isMcqSection ? `
- options: array of EXACTLY 4 option strings ["option1", "option2", "option3", "option4"]. Extract the text of each option WITHOUT the numbering "(1)", "(2)", etc.` : ""}
- syllabusTopic: "${secLabel}"${isChinese ? `

CHINESE PAPER — language-specific stem rules:
- Preserve Chinese characters EXACTLY. Do NOT translate. Keep full-width punctuation (。，、：；""「」《》！？) as printed.
- STRIP THE LEADING QUESTION NUMBER FROM THE STEM. questionNum carries the digit already; the stem must start with the question's own text — never "1." / "1．" / "1、" / "(1)" / "Q1 …". If the OCR line reads "1．他做事很__马虎__。" the stem you emit must read "他做事很__马虎__。".
- STRIP THE SECTION INSTRUCTION FROM EVERY STEM. The instruction line at the top of the section (e.g. for 语文应用 MCQ: "下面各题的句子里都有一个词语用横线划起来。从甲，乙，丙，丁四个答案中选出意思最相近的一个。") appears ONCE in the OCR text. It is NOT part of any individual question. Do NOT prepend it to any stem. Every question's stem starts with the question's own text only.
- CRITICAL — EMPHASIS MARKUP PASS-THROUGH: the OCR text above has already wrapped bold / underlined phrases in markdown (**phrase** for bold, __phrase__ for underline, **__phrase__** for both). Copy these markers VERBATIM into the stem AND every option string. NEVER strip them. NEVER "clean them up". For 语文应用 MCQ (Q1-15) this is the single most important rule — the emphasised word IS what's being tested. If a Q13-15-style option contains "**马虎** 地写字", your options[2] string must read "**马虎** 地写字" character-for-character.
- Watch for visually similar characters: 己/已/巳, 末/未, 戍/戌/戊, 千/干/于, 几/凡 etc. The OCR was done with a top-tier model — trust its character choice and copy it through.` : ""}

Return ONLY valid JSON:
{
  "questions": [
    ${isMcqSection
      ? `{"questionNum": "${secFirstQ}", "stem": "<question text>", "options": ["<opt1>", "<opt2>", "<opt3>", "<opt4>"], "syllabusTopic": "${secLabel}"}`
      : `{"questionNum": "${secFirstQ}", "stem": "<question text>", "syllabusTopic": "${secLabel}"}`
    }
  ]
}`;

  const extractResponse = await callWithChain(
    [{ text: extractPrompt }],
    `reextract-questions:${secLabel}`,
    { responseMimeType: "application/json", temperature: 0.1 },
  );

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
    // For 完成对话, force the syllabusTopic onto the canonical
    // Chinese label so the chinese-section builder + quiz UI
    // recognise it. Existing questions tagged "Dialogue Completion"
    // (English alias) get rewritten to "完成对话".
    if (isDialogueCompletion) updateData.syllabusTopic = CANONICAL_DIALOGUE_LABEL;

    if (Object.keys(updateData).length > 0) {
      await prisma.examQuestion.update({
        where: { id: existing.id },
        data: updateData,
      });
      updated++;
    }
  }

  // Step 4: Update sectionOcrTexts metadata. Canonicalise to "完成对话"
  // when this is a dialogue section — even if the UI passed a
  // different label like "Dialogue Completion".
  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const allOcr = (meta.sectionOcrTexts ?? {}) as Record<string, Record<string, unknown>>;
  const canonicalSectionName = isDialogueCompletion ? CANONICAL_DIALOGUE_LABEL : secLabel;
  const secKey = Object.keys(allOcr).find(k =>
    k.toLowerCase().replace(/\s+/g, "") === canonicalSectionName.toLowerCase().replace(/\s+/g, "")
  ) ?? canonicalSectionName;
  allOcr[secKey] = {
    ...(allOcr[secKey] ?? {}),
    ocrText,
    pageIndices,
    ...(passageOcrText ? { passageOcrText } : {}),
  };
  // Remove any English-aliased stale entry side by side.
  if (isDialogueCompletion && secLabel !== canonicalSectionName) {
    for (const k of Object.keys(allOcr)) {
      if (k !== secKey && k.toLowerCase().replace(/\s+/g, "") === secLabel.toLowerCase().replace(/\s+/g, "")) {
        delete allOcr[k];
        console.log(`[Re-extract] removed stale section key "${k}" (canonicalised to "${secKey}")`);
      }
    }
  }
  // For Chinese papers, rebuild chineseSections so the UI picks up
  // (a) the relabelled section (完成对话 instead of "Dialogue
  // Completion") and (b) the passage / word-bank text we just OCR'd.
  // Without this, the section title and the word-bank renderer stay
  // stuck on the old metadata even though the questions + OCR were
  // updated. Read questions FRESH from the DB so the syllabusTopic
  // updates we just did are reflected.
  let chineseSectionsUpdate: Record<string, unknown> = {};
  if (isChinese) {
    const qsForBuild = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      orderBy: { orderIndex: "asc" },
      select: { pageIndex: true, syllabusTopic: true },
    });
    const built = buildChineseSections(qsForBuild, allOcr as Record<string, OcrEntry>);
    chineseSectionsUpdate = { chineseSections: built };
    console.log(`[Re-extract] rebuilt chineseSections (${built.length} sections): ${built.map(s => s.label).join(", ")}`);
  }

  await prisma.examPaper.update({
    where: { id },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: { ...meta, sectionOcrTexts: allOcr, ...chineseSectionsUpdate } as any },
  });

  return NextResponse.json({
    ocrText,
    questionsUpdated: updated,
    questionsExtracted: extractedQuestions.length,
  });
}
