// Per-paper answer-key re-extract + diff against stored.
//
// Pulls each paper's answer-key pages (metadata.answerPages, 1-indexed),
// fetches them from prod, asks Gemini to OCR + parse the answer key
// into { questionNum, answer }, then diffs each row against the
// stored question.answer. Outputs a markdown report you can scan.
//
// Usage:
//   npx tsx scripts/audit-answer-keys.ts <paperId> [paperId ...]
//   npx tsx scripts/audit-answer-keys.ts --subject Mathematics --year 2024
//   npx tsx scripts/audit-answer-keys.ts --all-psle           # every PSLE master
//
// Output:
//   eval/answer-key-audit-<timestamp>.md
//
// Requires:
//   - eval/cookie.txt    (admin session cookie)
//   - GEMINI_API_KEY     (env var; falls back to .env)

import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = process.env.PROD_BASE ?? "https://www.markforyou.com";
const COOKIE = (() => {
  try { return readFileSync(path.join(__dirname, "..", "eval", "cookie.txt"), "utf-8").trim(); }
  catch { return null; }
})();

const prisma = new PrismaClient();

type ExtractedAnswer = { questionNum: string; answer: string };

const PROMPT = `You are reading an answer-key page from a Singapore PSLE (or upper-primary) exam paper. The page lists question numbers followed by their expected answers — typically in a compact tabular layout.

Output STRICTLY this JSON shape — no markdown, no commentary:
{
  "answers": [
    { "questionNum": "1", "answer": "3" },
    { "questionNum": "2", "answer": "B" },
    { "questionNum": "12a", "answer": "42" }
  ]
}

Rules:
- "questionNum": match the printed number exactly (e.g. "1", "12", "21a", "32(b)", "33").
- "answer": the EXPECTED ANSWER as printed. If the key shows multiple acceptable forms separated by "/", "or", or commas, keep them in the string verbatim.
- For MCQ-style 1-4 / A-D answers, output just the option label (e.g. "3" or "B").
- For working-shown / multi-line OEQ answers, output the FINAL answer or the complete short answer text — not the working steps.
- For "see answer image" style entries where the key refers to a diagram only, output "[see answer image]".
- Do not invent question numbers that are not on the page. Do not include numbers you cannot read.`;

function parseArgs(): { paperIds: string[]; flags: Record<string, string | true> } {
  const argv = process.argv.slice(2);
  const paperIds: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      paperIds.push(a);
    }
  }
  return { paperIds, flags };
}

async function pickPapers(args: { paperIds: string[]; flags: Record<string, string | true> }) {
  if (args.paperIds.length > 0) {
    return prisma.examPaper.findMany({
      where: { id: { in: args.paperIds } },
      select: paperSelect(),
      orderBy: { title: "asc" },
    });
  }
  const where: Record<string, unknown> = { sourceExamId: null, paperType: null };
  if (args.flags["all-psle"]) {
    where.title = { contains: "PSLE", mode: "insensitive" };
  }
  if (typeof args.flags.subject === "string") {
    where.subject = { contains: args.flags.subject, mode: "insensitive" };
  }
  if (typeof args.flags.year === "string") {
    where.year = args.flags.year;
  }
  return prisma.examPaper.findMany({
    where: where as never,
    select: paperSelect(),
    orderBy: [{ subject: "asc" }, { title: "asc" }],
  });
}

function paperSelect() {
  return {
    id: true,
    title: true,
    subject: true,
    year: true,
    pageCount: true,
    metadata: true,
    questions: {
      select: { id: true, questionNum: true, answer: true, syllabusTopic: true, marksAvailable: true },
      orderBy: { orderIndex: "asc" },
    },
  };
}

async function fetchPage(paperId: string, pageIndex: number): Promise<Buffer | null> {
  if (!COOKIE) throw new Error("eval/cookie.txt missing — needed to fetch pages from prod");
  const r = await fetch(`${BASE}/api/exam/${paperId}/pages?page=${pageIndex}`, {
    headers: { cookie: `yuna_session=${COOKIE}` },
  });
  if (r.status !== 200) return null;
  const buf = await r.arrayBuffer();
  return Buffer.from(buf);
}

async function extractKeyFromPage(ai: GoogleGenAI, pageBytes: Buffer): Promise<ExtractedAnswer[]> {
  // gemini-3.1-pro-preview replaced 2.5 (-pro / -flash) for answer-key
  // OCR — observed materially better extraction on PSLE-style key
  // tables in late May 2026. One-time audit run, accuracy matters
  // far more than throughput here.
  const resp = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/jpeg", data: pageBytes.toString("base64") } },
      { text: PROMPT },
    ]}],
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  const text = resp.text ?? "{}";
  try {
    const parsed = JSON.parse(text) as { answers?: Array<{ questionNum?: string; answer?: string }> };
    return (parsed.answers ?? [])
      .filter(a => a.questionNum && a.answer != null)
      .map(a => ({ questionNum: String(a.questionNum), answer: String(a.answer) }));
  } catch {
    return [];
  }
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
}

// Returns "match" | "minor" | "diff" | "missing-stored"
function classify(stored: string | null, extracted: string): "match" | "minor" | "diff" | "missing-stored" {
  if (!stored) return "missing-stored";
  const ns = normalize(stored);
  const ne = normalize(extracted);
  if (ns === ne) return "match";
  // strip parens / leading article
  const strip = (s: string) => s.replace(/[()]/g, "").replace(/^the\s+/i, "").trim();
  if (strip(ns) === strip(ne)) return "minor";
  // numeric tolerance — same number, different formatting
  const numS = ns.match(/^-?\d+(?:\.\d+)?/)?.[0];
  const numE = ne.match(/^-?\d+(?:\.\d+)?/)?.[0];
  if (numS && numE && numS === numE) return "minor";
  return "diff";
}

async function main() {
  const args = parseArgs();
  const papers = await pickPapers(args);
  if (papers.length === 0) {
    console.error("No papers matched. Pass paperIds or filter flags.");
    process.exit(2);
  }

  const apiKey = process.env.GEMINI_API_KEY ?? readFileSync(path.join(__dirname, "..", ".env"), "utf-8")
    .split(/\r?\n/).find(l => l.startsWith("GEMINI_API_KEY="))?.split("=")[1]?.replace(/^"|"$/g, "");
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const ai = new GoogleGenAI({ apiKey });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(__dirname, "..", "eval", `answer-key-audit-${ts}.md`);
  const lines: string[] = [];
  lines.push("# Answer-key audit");
  lines.push("");
  lines.push(`_Generated ${new Date().toISOString()}._`);
  lines.push("");
  lines.push(`Papers audited: ${papers.length}.`);
  lines.push("");
  lines.push("Each section lists per-question diffs between the stored answer and a fresh Gemini extraction of the answer-key page(s). Categories:");
  lines.push("");
  lines.push("- **diff** — material disagreement, likely audit candidate.");
  lines.push("- **minor** — formatting / whitespace / parens; usually safe.");
  lines.push("- **missing-stored** — no answer stored, key has one.");
  lines.push("- **missing-extracted** — answer stored, key page didn't return a row for it (OCR may have missed it).");
  lines.push("");
  let totalDiff = 0;
  let totalMinor = 0;
  let totalMissing = 0;

  for (const p of papers) {
    const meta = (p.metadata ?? {}) as { answerPages?: number[] };
    const answerPages1Indexed = meta.answerPages ?? [];
    if (answerPages1Indexed.length === 0) {
      lines.push(`## ${p.title}`);
      lines.push("");
      lines.push("⚠️ No `answerPages` in metadata — skipping.");
      lines.push("");
      console.log(`[skip] ${p.title}: no answerPages metadata`);
      continue;
    }
    console.log(`[audit] ${p.title} (${answerPages1Indexed.length} answer pages)`);
    const allExtracted: ExtractedAnswer[] = [];
    for (const oneBased of answerPages1Indexed) {
      const pageIdx = oneBased - 1;
      const bytes = await fetchPage(p.id, pageIdx);
      if (!bytes) {
        lines.push(`⚠️ Could not fetch page ${oneBased} of ${p.title}`);
        continue;
      }
      const rows = await extractKeyFromPage(ai, bytes);
      console.log(`  page ${oneBased}: extracted ${rows.length} rows`);
      allExtracted.push(...rows);
    }
    // Match by questionNum (normalised).
    const norm = (n: string) => n.toLowerCase().replace(/[\s()]/g, "");
    const extractedByNum = new Map<string, string>();
    for (const r of allExtracted) extractedByNum.set(norm(r.questionNum), r.answer);

    const diffs: Array<{ qNum: string; status: string; stored: string; extracted: string; topic: string | null }> = [];
    for (const q of p.questions) {
      const extracted = extractedByNum.get(norm(q.questionNum));
      if (extracted == null) {
        if ((q.answer ?? "").trim()) {
          diffs.push({ qNum: q.questionNum, status: "missing-extracted", stored: (q.answer ?? "").slice(0, 200), extracted: "—", topic: q.syllabusTopic });
        }
        continue;
      }
      const cls = classify(q.answer, extracted);
      if (cls === "match") continue;
      diffs.push({ qNum: q.questionNum, status: cls, stored: (q.answer ?? "—").slice(0, 200), extracted: extracted.slice(0, 200), topic: q.syllabusTopic });
      if (cls === "diff") totalDiff++;
      if (cls === "minor") totalMinor++;
      if (cls === "missing-stored") totalMissing++;
    }

    lines.push(`## ${p.title}${p.subject ? `  — _${p.subject}_` : ""}${p.year ? ` (${p.year})` : ""}`);
    lines.push("");
    lines.push(`Answer pages: ${answerPages1Indexed.join(", ")}. Diffs: ${diffs.length} / ${p.questions.length} questions.`);
    lines.push("");
    if (diffs.length === 0) {
      lines.push("✓ All stored answers match the extracted key.");
      lines.push("");
      continue;
    }
    lines.push("| Q | Status | Stored | Extracted | Topic |");
    lines.push("|---|---|---|---|---|");
    for (const d of diffs) {
      const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${d.qNum} | ${d.status} | ${esc(d.stored)} | ${esc(d.extracted)} | ${esc(d.topic ?? "")} |`);
    }
    lines.push("");
  }

  lines.unshift(`Totals so far: **${totalDiff} diff**, ${totalMinor} minor, ${totalMissing} missing-stored.\n`);
  mkdirSync(path.join(__dirname, "..", "eval"), { recursive: true });
  writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`Wrote ${outPath}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
