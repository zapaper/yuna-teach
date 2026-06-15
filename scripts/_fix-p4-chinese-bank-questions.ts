// One-off cleanup for P4 Chinese paper cmqdxv8eh000111t0px0v087h.
//
// 词语搭配 (Q11-Q14) and 短文填空 (Q15-Q18) were mis-extracted as MCQ
// with 4 word options each. The actual format is a shared phrase bank
// of 8 items at the top of the section; each question prompts a
// phrase + blank, and the student writes the number (1-8) from the
// bank that completes it. Same shape as 完成对话.
//
// Fix:
//   - clear transcribedOptions (no longer MCQ)
//   - normalize answer to "(N)" — strip the trailing word the OCR
//     pass tacked on (e.g. "(3) 摇摆身体" → "(3)", "5 担心" → "(5)")
//
// Dry-run by default; pass --apply to write.

import { prisma } from "../src/lib/db";

// Paper ID can be overridden via --paper <id>. Defaults to the
// first Nanyang P4 paper we cleaned up; second invocation should
// pass --paper cmqeqdqty00014ny153jypwb6.
const argv = process.argv.slice(2);
const paperIdx = argv.indexOf("--paper");
const PAPER_ID = paperIdx >= 0 ? argv[paperIdx + 1] : "cmqdxv8eh000111t0px0v087h";
const TOPICS = ["词语搭配", "短文填空"];
const apply = argv.includes("--apply");

function normalizeAnswer(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  // Match a number 1-8 anywhere in the answer (optionally wrapped in
  // parens). The number is the canonical answer; everything else is
  // the OCR-tacked-on word that we drop.
  const m = raw.match(/\(?\s*([1-8])\s*\)?/);
  if (!m) return raw;
  return `(${m[1]})`;
}

// 词语搭配 stems come out of clean-extract as "摇摆 ( )" — the parens
// is meant to be the writable blank, but the grammar-cloze quiz
// renderer expects six-underscore blanks like "摇摆 ______". Swap the
// parens-with-spaces marker to underscores so the renderer picks up
// the blank correctly. 短文填空 stems already use ______, so this
// is a no-op for them.
function normalizeStem(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  return raw.replace(/\(\s+\)/g, "______");
}

// 词语搭配 passages come out of clean-extract as flat OCR text:
//   "(1) 家长 (2) 插队 (3) 身体\n(4) 穷人 ..."
// The quiz renderer shows it as a wall of text. Re-format the
// numbered-phrase list block into a markdown table so the bank
// renders as a visible grid above the questions. Leaves the
// header line + question list unchanged.
function normalizePassageBank(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  // Find every "(N) WORD" token; group them all together. We only
  // rewrite when there are at least 4 phrases, and the rewrite
  // collapses the entire bank block (one or more consecutive lines
  // of (N) phrases) into a single markdown table line.
  const tokenRe = /\((\d+)\)\s*([^\s()]+(?:\s+[^\s()]+)*?)(?=\s*\(\d+\)|\s*$|\n)/g;
  // Find the contiguous bank block: scan for ≥ 2 lines that look like
  // ONLY (N) phrases with no Q markers.
  const lines = raw.split(/\r?\n/);
  const bankStart = lines.findIndex(l => /^\s*\(\d+\)/.test(l) && !/Q\d+/.test(l));
  if (bankStart < 0) return raw;
  let bankEnd = bankStart;
  while (bankEnd + 1 < lines.length && /^\s*\(\d+\)/.test(lines[bankEnd + 1]) && !/Q\d+/.test(lines[bankEnd + 1])) {
    bankEnd++;
  }
  const bankBlock = lines.slice(bankStart, bankEnd + 1).join("\n");
  const tokens: Array<{ n: string; w: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(bankBlock)) !== null) {
    tokens.push({ n: m[1], w: m[2].trim() });
  }
  if (tokens.length < 4) return raw;
  // Build a markdown table — 3 columns per row (so 6 phrases = 2
  // rows × 3 cols, 8 phrases = 2 rows × 4 cols, etc).
  const COLS = tokens.length % 4 === 0 ? 4 : 3;
  const rows: string[] = [];
  rows.push(`| ${Array(COLS).fill(" ").join(" | ")} |`);
  rows.push(`|${Array(COLS).fill("---").join("|")}|`);
  for (let i = 0; i < tokens.length; i += COLS) {
    const cells = tokens.slice(i, i + COLS).map(t => `(${t.n}) ${t.w}`);
    while (cells.length < COLS) cells.push("");
    rows.push(`| ${cells.join(" | ")} |`);
  }
  const tableMd = rows.join("\n");
  const before = lines.slice(0, bankStart).join("\n");
  const after = lines.slice(bankEnd + 1).join("\n");
  return [before.trimEnd(), tableMd, after.trimStart()].filter(Boolean).join("\n\n");
}

(async () => {
  // Rewrite the 词语搭配 section's passage bank-block to a markdown
  // table so the renderer displays the phrase list as a grid.
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { metadata: true },
  });
  const meta = paper?.metadata as { chineseSections?: Array<{ label: string; passage?: string; startIndex: number; endIndex: number }> } | null;
  if (meta?.chineseSections) {
    let touched = false;
    const updated = meta.chineseSections.map(s => {
      if (s.label !== "词语搭配") return s;
      const newPassage = normalizePassageBank(s.passage);
      if (newPassage && newPassage !== s.passage) {
        console.log(`  词语搭配 passage: rewrote bank block to markdown table`);
        touched = true;
        return { ...s, passage: newPassage };
      }
      return s;
    });
    if (touched && apply) {
      await prisma.examPaper.update({
        where: { id: PAPER_ID },
        data: { metadata: { ...meta, chineseSections: updated } as never },
      });
    }
  }

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, syllabusTopic: { in: TOPICS } },
    select: { id: true, questionNum: true, syllabusTopic: true, transcribedOptions: true, answer: true, transcribedStem: true },
    orderBy: { orderIndex: "asc" },
  });
  console.log(`${apply ? "APPLY" : "DRY-RUN"} — touching ${qs.length} questions`);
  for (const q of qs) {
    const newAnswer = normalizeAnswer(q.answer);
    const newStem = normalizeStem(q.transcribedStem);
    const stemChanged = newStem !== q.transcribedStem;
    const hadOptions = Array.isArray(q.transcribedOptions) && q.transcribedOptions.length > 0;
    console.log(`  Q${q.questionNum} (${q.syllabusTopic}):`);
    console.log(`    options ${hadOptions ? "→ cleared" : "(already empty)"}`);
    console.log(`    answer ${JSON.stringify(q.answer)} → ${JSON.stringify(newAnswer)}`);
    if (stemChanged) console.log(`    stem   ${JSON.stringify(q.transcribedStem)} → ${JSON.stringify(newStem)}`);
    if (apply) {
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { transcribedOptions: [], answer: newAnswer, transcribedStem: newStem },
      });
    }
  }
  if (!apply) console.log("\nPass --apply to write.");
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
