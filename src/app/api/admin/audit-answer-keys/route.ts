// Admin: re-extract every question's answer with gemini-3.1-pro-preview
// (the same per-question OCR path /edit's "Re-extract Answer" uses, just
// looped) and diff against the stored examQuestion.answer rows. Surfaces
// stored answers that disagree with what's actually printed on the
// answer-key page(s). Used by /admin/audit-answer-keys.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

// Same fallback chain as /api/exam/questions/[id]/reextract-answer.
const REEXTRACT_MODELS = ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"] as const;

// Cap concurrent per-question Gemini calls to avoid 429s. The reextract
// pattern proves single-question prompts work; we just need them in bulk.
const CONCURRENCY = 4;

type PerQ = {
  questionId: string;
  questionNum: string;
  stem: string;
  marks: number;
  storedAnswer: string;
  topic: string | null;
};

async function reextractOne(
  q: PerQ,
  pageImagesB64: string[],
  isChinese: boolean,
): Promise<{ answer: string } | { error: string }> {
  const qNum = q.questionNum;
  const marks = q.marks;
  const stem = (q.stem ?? "").slice(0, 600);

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  for (const img of pageImagesB64) {
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
- 如果答案册里 **没有** ${qNum} 题，请返回 {"answer": ""}。
- 输出格式：以 " | " (空格 + 竖线 + 空格) 分隔多行，不要使用换行符。

请返回 JSON:
{"answer": "<参考答案，保留 (0.5) 等评分标注>"}` : `Extract the answer key for question ${qNum} from the answer-sheet page(s) above.

Question stem (for context):
${stem || "(none)"}

Marks available: ${marks}

Rules:
- Find the entry labelled "${qNum}" (or "Q${qNum}", "${qNum}.", "${qNum})" etc.) on the answer key.
- Copy the FULL answer including any working steps. Use " | " (space pipe space) to separate steps — do NOT use literal newlines.
- For MCQ-style answers, output the option label exactly as printed (e.g. "(3)" or "C" or "3").
- If a marking scheme is printed alongside the answer, append it after the main answer.
- For "see answer image" / diagram-only entries, output "[see answer image]".
- If the answer key does NOT contain question ${qNum}, return {"answer": ""}.

Return JSON:
{"answer": "<answer key value, including working / rubric>"}`,
  });

  let lastErr: unknown = null;
  for (let mi = 0; mi < REEXTRACT_MODELS.length; mi++) {
    const model = REEXTRACT_MODELS[mi];
    try {
      const response = await generateContentWithRetry({
        model,
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      }, 0, 3000, `audit-answer-keys:q${qNum}:${model}`);
      const text = response.text?.trim() ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { lastErr = new Error("no JSON in response"); continue; }
      const parsed = JSON.parse(m[0]) as { answer?: string };
      const answer = (parsed.answer ?? "").trim();
      if (mi > 0) console.log(`[audit-answer-keys] q${qNum}: succeeded on fallback model ${model}`);
      return { answer };
    } catch (err) {
      lastErr = err;
      console.warn(`[audit-answer-keys] q${qNum} on ${model} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { error: lastErr instanceof Error ? lastErr.message : "lookup failed" };
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
}

function classify(
  stored: string | null,
  extracted: string,
): "match" | "minor" | "diff" | "missing-stored" | "missing-extracted" {
  if (!extracted.trim()) return "missing-extracted";
  if (!stored || !stored.trim()) return "missing-stored";
  const ns = normalize(stored);
  const ne = normalize(extracted);
  if (ns === ne) return "match";
  const strip = (s: string) => s.replace(/[()]/g, "").replace(/^the\s+/i, "").trim();
  if (strip(ns) === strip(ne)) return "minor";
  const numS = ns.match(/^-?\d+(?:\.\d+)?/)?.[0];
  const numE = ne.match(/^-?\d+(?:\.\d+)?/)?.[0];
  if (numS && numE && numS === numE) return "minor";
  return "diff";
}

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({})) as { paperId?: string };
  if (!body.paperId) return NextResponse.json({ error: "paperId required" }, { status: 400 });

  const paper = await prisma.examPaper.findUnique({
    where: { id: body.paperId },
    select: {
      id: true, title: true, subject: true, year: true,
      metadata: true,
      questions: {
        select: {
          id: true, questionNum: true, answer: true, syllabusTopic: true,
          marksAvailable: true, transcribedStem: true,
        },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  const meta = (paper.metadata ?? {}) as { answerPages?: number[] };
  const answerPages1Indexed = meta.answerPages ?? [];
  if (answerPages1Indexed.length === 0) {
    return NextResponse.json({
      paperId: paper.id,
      title: paper.title,
      error: "No answerPages in metadata for this paper.",
      diffs: [],
    });
  }

  // Read the answer-key pages once, share across every question call.
  const pageImagesB64: string[] = [];
  const pageReadErrors: string[] = [];
  for (const oneBased of answerPages1Indexed) {
    const pageIdx = oneBased - 1;
    const pagePath = path.join(PAGES_DIR, paper.id, `page_${pageIdx}.jpg`);
    if (!fsSync.existsSync(pagePath)) {
      pageReadErrors.push(`page ${oneBased} missing on disk`);
      continue;
    }
    pageImagesB64.push((await fs.readFile(pagePath)).toString("base64"));
  }
  if (pageImagesB64.length === 0) {
    return NextResponse.json({
      paperId: paper.id,
      title: paper.title,
      error: `Could not read any answer pages: ${pageReadErrors.join(", ")}`,
      diffs: [],
    });
  }

  const isChinese = (paper.subject ?? "").toLowerCase().includes("chinese");

  type Diff = {
    qId: string;
    qNum: string;
    status: "match" | "minor" | "diff" | "missing-stored" | "missing-extracted";
    stored: string;
    extracted: string;
    topic: string | null;
    marks: number | null;
    error?: string;
  };
  const diffs: Diff[] = new Array(paper.questions.length);

  // Bounded concurrency — N workers walking a shared cursor.
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= paper.questions.length) return;
      const q = paper.questions[idx];
      const perQ: PerQ = {
        questionId: q.id,
        questionNum: q.questionNum,
        stem: q.transcribedStem ?? "",
        marks: q.marksAvailable ?? 1,
        storedAnswer: q.answer ?? "",
        topic: q.syllabusTopic,
      };
      const result = await reextractOne(perQ, pageImagesB64, isChinese);
      if ("error" in result) {
        diffs[idx] = {
          qId: q.id,
          qNum: q.questionNum,
          status: "missing-extracted",
          stored: q.answer ?? "",
          extracted: "",
          topic: q.syllabusTopic,
          marks: q.marksAvailable,
          error: result.error,
        };
      } else {
        diffs[idx] = {
          qId: q.id,
          qNum: q.questionNum,
          status: classify(q.answer, result.answer),
          stored: q.answer ?? "",
          extracted: result.answer,
          topic: q.syllabusTopic,
          marks: q.marksAvailable,
        };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const counts = {
    match: diffs.filter(d => d.status === "match").length,
    minor: diffs.filter(d => d.status === "minor").length,
    diff: diffs.filter(d => d.status === "diff").length,
    missingStored: diffs.filter(d => d.status === "missing-stored").length,
    missingExtracted: diffs.filter(d => d.status === "missing-extracted").length,
  };

  return NextResponse.json({
    paperId: paper.id,
    title: paper.title,
    subject: paper.subject,
    year: paper.year,
    answerPages: answerPages1Indexed,
    pageReadErrors,
    questionCount: paper.questions.length,
    counts,
    diffs,
  });
}
