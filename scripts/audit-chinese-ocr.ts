import path from "path";
import fs from "fs";
import { prisma } from "../src/lib/db";
import { generateContentWithRetry } from "../src/lib/gemini";

// Audit Chinese master-paper OCR by:
//   1. Re-OCR every section's pages with gemini-2.5-pro (read-only, no DB write).
//   2. Diff the new OCR text against the existing metadata.sectionOcrTexts
//      (the flash output stored on the paper).
//   3. For sections where the diff is non-trivial, send a SAMPLE page image
//      plus both transcriptions to a vision judge (also 2.5-pro) and ask
//      which one matches the printed page more accurately.
//   4. Write a JSON report — one entry per audited section with verdict +
//      a few illustrative differing phrases. Paper-level summary at the top.
//
// Use:
//   npx tsx scripts/audit-chinese-ocr.ts              # all Chinese masters
//   npx tsx scripts/audit-chinese-ocr.ts --paper <id> # one paper
//   npx tsx scripts/audit-chinese-ocr.ts --limit 3    # first N papers
//
// Outputs to scripts/chinese-ocr-audit-<timestamp>.json. Designed so you
// never need to eyeball pages — read the report and re-extract the papers
// the judge flagged.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

type SectionOcr = {
  ocrText: string;
  pageIndices: number[];
  passageOcrText?: string;
};
type SectionOcrMap = Record<string, SectionOcr>;

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
  "errors_in_a": ["<具体错误1>", "<具体错误2>"],
  "errors_in_b": ["<具体错误1>"],
  "summary": "<一句话总结>"
}

errors_in_* 数组只列出你确定的错误，最多 5 条，每条简短说明。如果某版本没有错误，就给空数组。`;

type JudgeResult = {
  winner: "A" | "B" | "both_same" | "both_bad" | string;
  errors_in_a: string[];
  errors_in_b: string[];
  summary: string;
};

async function reOcrPage(imageB64: string): Promise<string> {
  const res = await generateContentWithRetry({
    model: "gemini-2.5-pro",
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: imageB64 } },
        { text: RE_OCR_PROMPT },
      ],
    }],
    config: { temperature: 0.1 },
  }, 1, 3000, "audit-reocr");
  return (res.text ?? "").trim();
}

async function judgePage(imageB64: string, versionA: string, versionB: string): Promise<JudgeResult | null> {
  try {
    const res = await generateContentWithRetry({
      model: "gemini-2.5-pro",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: imageB64 } },
          { text: `${JUDGE_PROMPT}\n\n===== 版本 A (现有 OCR) =====\n${versionA.slice(0, 4000)}\n\n===== 版本 B (重新 OCR) =====\n${versionB.slice(0, 4000)}` },
        ],
      }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    }, 1, 3000, "audit-judge");
    const text = (res.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as JudgeResult;
  } catch (err) {
    console.warn(`  judge failed:`, (err as Error).message);
    return null;
  }
}

// Quick distance metric — true Levenshtein would be expensive on long strings.
// Approximate via length-normalised symmetric diff of trigrams. Returns 0-1.
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

(async () => {
  const args = process.argv.slice(2);
  const onePaper = (() => {
    const i = args.indexOf("--paper");
    return i >= 0 ? args[i + 1] : null;
  })();
  const limit = (() => {
    const i = args.indexOf("--limit");
    return i >= 0 ? parseInt(args[i + 1], 10) || 0 : 0;
  })();

  let papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: "chinese", mode: "insensitive" },
      ...(onePaper ? { id: onePaper } : {}),
    },
    select: { id: true, title: true, level: true, metadata: true, pageCount: true },
    orderBy: { createdAt: "asc" },
  });
  if (limit > 0) papers = papers.slice(0, limit);

  console.log(`${"=".repeat(70)}`);
  console.log(`Chinese OCR audit — re-OCR with 2.5-pro + judge`);
  console.log(`Papers to audit: ${papers.length}`);
  console.log(`${"=".repeat(70)}\n`);

  type SectionReport = {
    sectionLabel: string;
    pageIndices: number[];
    oldLen: number;
    newLen: number;
    distance: number;
    judge: JudgeResult | null;
    sampleOld: string;
    sampleNew: string;
  };
  type PaperReport = {
    paperId: string;
    title: string;
    level: string | null;
    sectionsAudited: number;
    sectionsWithDiff: number;
    sectionsJudgedNewBetter: number;
    sectionsJudgedOldBetter: number;
    sectionsJudgedSame: number;
    totalErrorsInOld: number;
    totalErrorsInNew: number;
    sections: SectionReport[];
  };
  const report: PaperReport[] = [];

  for (const [pi, p] of papers.entries()) {
    const dir = path.join(PAGES_DIR, p.id);
    if (!fs.existsSync(dir)) {
      console.log(`${pi + 1}/${papers.length}  ${p.id}  — pages dir missing, skip`);
      continue;
    }
    const meta = p.metadata as { sectionOcrTexts?: SectionOcrMap } | null;
    const oldOcr = meta?.sectionOcrTexts ?? {};
    const sectionKeys = Object.keys(oldOcr);
    if (sectionKeys.length === 0) {
      console.log(`${pi + 1}/${papers.length}  ${p.id}  "${p.title}" — no sectionOcrTexts, skip`);
      continue;
    }

    console.log(`\n${pi + 1}/${papers.length}  ${p.id}  "${p.title}"  (${sectionKeys.length} sections)`);
    const pr: PaperReport = {
      paperId: p.id,
      title: p.title,
      level: p.level,
      sectionsAudited: 0,
      sectionsWithDiff: 0,
      sectionsJudgedNewBetter: 0,
      sectionsJudgedOldBetter: 0,
      sectionsJudgedSame: 0,
      totalErrorsInOld: 0,
      totalErrorsInNew: 0,
      sections: [],
    };

    for (const key of sectionKeys) {
      const sec = oldOcr[key];
      if (!sec?.ocrText || !sec.pageIndices?.length) continue;
      // Use the FIRST page of the section as the judge anchor — keeps
      // the judge call cheap (one image). The re-OCR also uses just
      // that page so both A and B describe the same source content.
      const pageIdx = sec.pageIndices[0];
      const pagePath = path.join(dir, `page_${pageIdx}.jpg`);
      if (!fs.existsSync(pagePath)) {
        console.log(`  ${key} — page_${pageIdx}.jpg missing, skip`);
        continue;
      }
      const imgB64 = fs.readFileSync(pagePath).toString("base64");

      let newOcr: string;
      try {
        newOcr = await reOcrPage(imgB64);
      } catch (err) {
        console.log(`  ${key} — re-OCR failed: ${(err as Error).message.slice(0, 80)}`);
        continue;
      }

      const oldText = sec.ocrText;
      const dist = approxDistance(oldText, newOcr);
      pr.sectionsAudited++;
      const section: SectionReport = {
        sectionLabel: key,
        pageIndices: sec.pageIndices,
        oldLen: oldText.length,
        newLen: newOcr.length,
        distance: dist,
        judge: null,
        sampleOld: oldText.slice(0, 200),
        sampleNew: newOcr.slice(0, 200),
      };

      // Threshold: only invoke the judge if the trigram distance is >5%.
      // Below that, formatting whitespace dominates and isn't worth a
      // judge call.
      if (dist >= 0.05) {
        pr.sectionsWithDiff++;
        const verdict = await judgePage(imgB64, oldText, newOcr);
        section.judge = verdict;
        if (verdict) {
          pr.totalErrorsInOld += verdict.errors_in_a?.length ?? 0;
          pr.totalErrorsInNew += verdict.errors_in_b?.length ?? 0;
          if (verdict.winner === "B") pr.sectionsJudgedNewBetter++;
          else if (verdict.winner === "A") pr.sectionsJudgedOldBetter++;
          else pr.sectionsJudgedSame++;
        }
      }
      pr.sections.push(section);
      console.log(`  ${key}: dist=${dist.toFixed(3)}  judge=${section.judge?.winner ?? "skipped"}  oldErr=${section.judge?.errors_in_a?.length ?? 0}  newErr=${section.judge?.errors_in_b?.length ?? 0}`);
    }

    report.push(pr);
  }

  // Summary
  const totalSections = report.reduce((a, r) => a + r.sectionsAudited, 0);
  const totalDiffs = report.reduce((a, r) => a + r.sectionsWithDiff, 0);
  const totalNewBetter = report.reduce((a, r) => a + r.sectionsJudgedNewBetter, 0);
  const totalOldBetter = report.reduce((a, r) => a + r.sectionsJudgedOldBetter, 0);
  const totalSame = report.reduce((a, r) => a + r.sectionsJudgedSame, 0);
  const totalOldErrors = report.reduce((a, r) => a + r.totalErrorsInOld, 0);
  const totalNewErrors = report.reduce((a, r) => a + r.totalErrorsInNew, 0);

  console.log(`\n${"=".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${"=".repeat(70)}`);
  console.log(`Papers audited: ${report.length}`);
  console.log(`Sections audited: ${totalSections}`);
  console.log(`Sections with diff (>5%): ${totalDiffs}`);
  console.log(`  judge said NEW (pro) better:    ${totalNewBetter}`);
  console.log(`  judge said OLD (flash) better:  ${totalOldBetter}`);
  console.log(`  judge said same / both bad:     ${totalSame}`);
  console.log(`Total transcription errors in OLD: ${totalOldErrors}`);
  console.log(`Total transcription errors in NEW: ${totalNewErrors}`);

  // Worst-offender papers
  const sorted = [...report].sort((a, b) => b.totalErrorsInOld - a.totalErrorsInOld);
  console.log(`\nWorst papers (most errors in current/flash OCR):`);
  for (const r of sorted.slice(0, 10)) {
    if (r.totalErrorsInOld === 0) break;
    console.log(`  ${String(r.totalErrorsInOld).padStart(3)} errors  ${r.paperId}  "${(r.title ?? "").slice(0, 50)}"`);
  }

  const outPath = path.join(process.cwd(), "scripts", `chinese-ocr-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    summary: {
      papers: report.length,
      sectionsAudited: totalSections,
      sectionsWithDiff: totalDiffs,
      newBetter: totalNewBetter,
      oldBetter: totalOldBetter,
      same: totalSame,
      oldErrors: totalOldErrors,
      newErrors: totalNewErrors,
    },
    papers: report,
  }, null, 2));
  console.log(`\nFull report written to ${outPath}`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
