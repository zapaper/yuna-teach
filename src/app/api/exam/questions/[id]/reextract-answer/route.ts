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
      examPaper: { select: { id: true, subject: true } },
    },
  });
  if (!question) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  const pagesDir = path.join(VOLUME_PATH, "pages", question.examPaper.id);
  const imagesBase64: string[] = [];
  for (const pageIdx of pageIndices) {
    const filePath = path.join(pagesDir, `page_${pageIdx}.jpg`);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: `Page ${pageIdx} not found on disk` }, { status: 404 });
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

  try {
    const response = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    }, 1, 3000, `reextract-answer:q${qNum}`);
    const text = response.text?.trim() ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return NextResponse.json({ error: "no JSON in response", raw: text.slice(0, 200) }, { status: 502 });
    const parsed = JSON.parse(m[0]) as { answer?: string };
    const answer = (parsed.answer ?? "").trim();
    if (!answer) return NextResponse.json({ error: "empty answer in response" }, { status: 502 });
    await prisma.examQuestion.update({
      where: { id: questionId },
      data: { answer },
    });
    return NextResponse.json({ answer });
  } catch (err) {
    console.error(`[reextract-answer] q${qNum} failed:`, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "lookup failed" }, { status: 500 });
  }
}
