import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import fs from "fs";
import path from "path";

const VOLUME_PATH = process.env.VOLUME_PATH || "/data";

// Per-question Re-extract Answer. Admin types the answer-key page
// number(s) in /edit and we re-run a one-shot OCR against just that
// page targeted at this question's number. Saves the result to
// examQuestion.answer. Used when the bulk answer-extract pass got
// it wrong (e.g. the Chinese 长 OEQ where the AI only grabbed the
// footnote and missed the underlined model answer).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: questionId } = await params;
  const { pageIndices } = await request.json() as { pageIndices: number[] };
  if (!Array.isArray(pageIndices) || pageIndices.length === 0) {
    return NextResponse.json({ error: "pageIndices required" }, { status: 400 });
  }

  const question = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      marksAvailable: true,
      examPaper: { select: { id: true, subject: true, pageCount: true } },
    },
  });
  if (!question) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  const pagesDir = path.join(VOLUME_PATH, "pages", question.examPaper.id);
  // Enumerate page_N.jpg actually on disk so the error message can tell
  // the admin what range is valid (1-indexed in the UI). This catches
  // typed-too-high page numbers AND missing files that should be there.
  let onDiskPages: number[] = [];
  try {
    onDiskPages = fs.readdirSync(pagesDir)
      .map(f => f.match(/^page_(\d+)\.jpg$/)?.[1])
      .filter((s): s is string => !!s)
      .map(s => parseInt(s, 10))
      .sort((a, b) => a - b);
  } catch {
    return NextResponse.json({ error: `No scanned pages found on disk for this paper.` }, { status: 404 });
  }
  const imagesBase64: string[] = [];
  for (const pageIdx of pageIndices) {
    const filePath = path.join(pagesDir, `page_${pageIdx}.jpg`);
    if (!fs.existsSync(filePath)) {
      // Report the page number the way the admin typed it (1-indexed)
      // and tell them the valid range so they don't have to guess.
      const userPage = pageIdx + 1;
      const onDiskCount = onDiskPages.length;
      const detail = onDiskCount > 0
        ? `Paper has pages 1–${onDiskCount} on disk.`
        : `No page images found for this paper.`;
      return NextResponse.json({ error: `Page ${userPage} not found on disk. ${detail}` }, { status: 404 });
    }
    imagesBase64.push(fs.readFileSync(filePath).toString("base64"));
  }

  const isChinese = (question.examPaper.subject ?? "").toLowerCase().includes("chinese");
  const qNum = question.questionNum;
  const marks = question.marksAvailable ?? 1;
  const stem = (question.transcribedStem ?? "").slice(0, 600);

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  for (const img of imagesBase64) {
    parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: img } });
  }

  parts.push({
    text: isChinese ? `你正在从新加坡 PSLE 华文答案册中抽取 ${qNum} 题 的参考答案。

题目 (供你参考)：
${stem || "(无)"}

满分: ${marks}

抽取规则：
- 找到答案册上标有 "${qNum}"、"Q${qNum}"、"${qNum}." 或 "${qNum})" 的那一项。把该题的 **完整范文 / 参考答案** 抄录出来。
- 长 OEQ (例如范文写作) 的参考答案通常以 **下划线** 标出 — 那段被划线的文字就是范文本身 (短信 / 邀请 / 段落)。每一个被划线的词或短语都必须出现在你的输出里。
- 短 OEQ (例如阅读理解二的 1-3 分题) 的参考答案多为短句或词组，可能没有下划线 — 把整条参考答案抄录出来即可。
- 不要 **只** 抽取「评分说明」或「注」之类的备注文字 — 那是说明文字，不是答案本身。但如果答案后面附带评分细则 (内容 2 分、语文 2 分、(0.5)、(1) 等分值标记)，请原样保留。
- 输出格式：以 " | " (空格 + 竖线 + 空格) 分隔多行，不要使用换行符。

请返回 JSON:
{"answer": "<参考答案，保留 (0.5) 等评分标注>"}` : `Extract the answer key for question ${qNum} from the answer-sheet page(s) above.

Question stem (for context):
${stem || "(none)"}

Marks available: ${marks}

Rules:
- Find the entry labelled "${qNum}" (or "Q${qNum}", "${qNum}.", "${qNum})" etc.) on the answer key.
- Copy the FULL answer including any working steps. Use " | " (space pipe space) to separate steps — do NOT use literal newlines.
- For MCQ answers, output the option label exactly as printed (e.g. "(3)" or "C").
- If a marking scheme is printed alongside the answer, append it after the main answer.

Return JSON:
{"answer": "<answer key value, including working / rubric>"}`,
  });

  // Lead with 3.1-pro-preview for accuracy on long OEQs / rubric pages;
  // fall back to 2.5-pro then 2.5-flash if upstream 504s.
  const REEXTRACT_MODELS = ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"] as const;
  let lastErr: unknown = null;
  for (let mi = 0; mi < REEXTRACT_MODELS.length; mi++) {
    const model = REEXTRACT_MODELS[mi];
    try {
      const response = await generateContentWithRetry({
        model,
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      }, 0, 3000, `reextract-answer:q${qNum}:${model}`);
      const text = response.text?.trim() ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        lastErr = new Error("no JSON in response");
        continue;
      }
      const parsed = JSON.parse(m[0]) as { answer?: string };
      const answer = (parsed.answer ?? "").trim();
      if (!answer) {
        lastErr = new Error("empty answer in response");
        continue;
      }
      if (mi > 0) console.log(`[reextract-answer] q${qNum}: succeeded on fallback model ${model}`);
      await prisma.examQuestion.update({
        where: { id: questionId },
        data: { answer },
      });
      return NextResponse.json({ answer });
    } catch (err) {
      lastErr = err;
      console.warn(`[reextract-answer] q${qNum} on ${model} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.error(`[reextract-answer] q${qNum} failed on all models:`, lastErr);
  return NextResponse.json({ error: lastErr instanceof Error ? lastErr.message : "lookup failed" }, { status: 500 });
}
