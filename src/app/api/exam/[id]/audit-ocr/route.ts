import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";

// Per-paper Chinese OCR audit.
//   1. Read existing metadata.sectionOcrTexts (the flash-extracted output).
//   2. For each section, re-OCR the first page image with gemini-2.5-pro.
//   3. If the new transcription differs meaningfully (trigram distance > 5%),
//      send (page image, old text, new text) to a vision judge that lists
//      the specific transcription errors in each version.
//   4. Return per-section findings so the /edit UI can banner them at the top.
//
// Read-only — never writes back. Admin-only.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

const RE_OCR_PROMPT = `你正在为新加坡 PSLE 华文试卷做 OCR。请把图片里的文字逐字抄录下来 — 这是用来检查另一个 OCR 输出的真实参考，所以**逐字准确**比格式重要。

规则：
- 保留所有汉字、标点、数字，原样输出，不要翻译。
- 保留段落分行；段落之间空一行。
- 保留印刷的 **粗体** / __下划线__ markdown 标记。
- 不要加任何说明或评论。直接输出抄录文字。`;

const JUDGE_PROMPT = `你是华文试卷 OCR 质量审核员。下面给你印刷页面图片，以及两个 OCR 抄录版本 A 和 B。请仔细比对图片和两个版本，判断哪个版本更准确地还原了图片上的文字。

重点检查这几类常见错误：
- 形近字误识别 (己/已/巳, 末/未, 戍/戌/戊, 千/干/于, 几/凡 等)
- 漏掉或多出的字
- 标点错误
- 漏掉的 **粗体** / __下划线__ 标记 (如果图片上确实有强调)

请返回 JSON:
{
  "winner": "A" | "B" | "both_same" | "both_bad",
  "errors_in_a": [{"snippet": "<出错的短语 (5-15字)>", "correction": "<正确的版本>", "note": "<一句话说明>"}],
  "errors_in_b": [{"snippet": "...", "correction": "...", "note": "..."}],
  "summary": "<一句话总结>"
}

每个数组最多 8 条具体错误，不要列泛泛而谈的描述。如果某版本没有可确认的错误，给空数组。`;

type JudgeError = { snippet: string; correction: string; note: string };
type JudgeResult = {
  winner: "A" | "B" | "both_same" | "both_bad" | string;
  errors_in_a: JudgeError[];
  errors_in_b: JudgeError[];
  summary: string;
};

function approxDistance(a: string, b: string): number {
  if (a === b) return 0;
  const tri = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
    return out;
  };
  const A = tri(a);
  const B = tri(b);
  if (A.size === 0 && B.size === 0) return 0;
  let intersect = 0;
  for (const t of A) if (B.has(t)) intersect++;
  const union = A.size + B.size - intersect;
  return union === 0 ? 0 : 1 - intersect / union;
}

type SectionOcr = { ocrText: string; pageIndices: number[]; passageOcrText?: string };

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { name: true, settings: true },
  });
  if (!isAdmin(me)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, title: true, subject: true, metadata: true },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  const isChinese = (paper.subject ?? "").toLowerCase().includes("chinese");
  if (!isChinese) {
    return NextResponse.json({ error: "Audit currently supports Chinese papers only" }, { status: 400 });
  }

  const meta = paper.metadata as { sectionOcrTexts?: Record<string, SectionOcr> } | null;
  const oldOcr = meta?.sectionOcrTexts ?? {};
  const sectionKeys = Object.keys(oldOcr);
  if (sectionKeys.length === 0) {
    return NextResponse.json({ error: "Paper has no sectionOcrTexts yet — extract first" }, { status: 400 });
  }

  const dir = path.join(PAGES_DIR, paper.id);
  try {
    await fs.stat(dir);
  } catch {
    return NextResponse.json({ error: "Page images missing from disk" }, { status: 404 });
  }

  type SectionFinding = {
    sectionLabel: string;
    pageIndex: number;
    distance: number;
    skipped?: string;
    judge?: JudgeResult | null;
  };
  const findings: SectionFinding[] = [];

  // Run sections in parallel — each section is at most one re-OCR + one
  // judge call, so 5-8 sections in parallel keeps the wall-clock down to
  // ~30-60s for a typical Chinese paper.
  await Promise.all(sectionKeys.map(async (key) => {
    const sec = oldOcr[key];
    if (!sec?.ocrText || !sec.pageIndices?.length) {
      findings.push({ sectionLabel: key, pageIndex: -1, distance: 0, skipped: "empty section" });
      return;
    }
    const pageIdx = sec.pageIndices[0];
    const pagePath = path.join(dir, `page_${pageIdx}.jpg`);
    let imgB64: string;
    try {
      imgB64 = (await fs.readFile(pagePath)).toString("base64");
    } catch {
      findings.push({ sectionLabel: key, pageIndex: pageIdx, distance: 0, skipped: `page_${pageIdx}.jpg missing` });
      return;
    }

    let newOcr: string;
    try {
      const r = await generateContentWithRetry({
        model: "gemini-2.5-pro",
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: imgB64 } },
            { text: RE_OCR_PROMPT },
          ],
        }],
        config: { temperature: 0.1 },
      }, 1, 3000, `audit-reocr:${key}`);
      newOcr = (r.text ?? "").trim();
    } catch (err) {
      findings.push({ sectionLabel: key, pageIndex: pageIdx, distance: 0, skipped: `re-OCR failed: ${(err as Error).message.slice(0, 80)}` });
      return;
    }

    const dist = approxDistance(sec.ocrText, newOcr);
    if (dist < 0.05) {
      findings.push({ sectionLabel: key, pageIndex: pageIdx, distance: dist });
      return;
    }

    let judge: JudgeResult | null = null;
    try {
      const r = await generateContentWithRetry({
        model: "gemini-2.5-pro",
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: imgB64 } },
            { text: `${JUDGE_PROMPT}\n\n===== 版本 A (现有 OCR) =====\n${sec.ocrText.slice(0, 4000)}\n\n===== 版本 B (重新 OCR) =====\n${newOcr.slice(0, 4000)}` },
          ],
        }],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      }, 1, 3000, `audit-judge:${key}`);
      const text = (r.text ?? "").trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (m) judge = JSON.parse(m[0]) as JudgeResult;
    } catch (err) {
      findings.push({ sectionLabel: key, pageIndex: pageIdx, distance: dist, skipped: `judge failed: ${(err as Error).message.slice(0, 80)}` });
      return;
    }
    findings.push({ sectionLabel: key, pageIndex: pageIdx, distance: dist, judge });
  }));

  // Sort findings by section label for stable display order.
  findings.sort((a, b) => a.sectionLabel.localeCompare(b.sectionLabel));

  return NextResponse.json({ paperId: paper.id, findings });
}
