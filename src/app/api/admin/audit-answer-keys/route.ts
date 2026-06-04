// Admin: re-extract a paper's answer key with gemini-3.1-pro-preview
// and diff against the stored question.answer rows. Used by
// /admin/audit-answer-keys to surface stored answers that disagree
// with what's actually printed on the answer-key page(s).

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const PAGES_DIR = path.join(VOLUME_PATH, "pages");

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  return _ai;
}

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

async function extractKeyFromPage(pageBytes: Buffer): Promise<ExtractedAnswer[]> {
  const resp = await getAI().models.generateContent({
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

function classify(stored: string | null, extracted: string): "match" | "minor" | "diff" | "missing-stored" {
  if (!stored) return "missing-stored";
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

function normNum(n: string): string {
  return n.toLowerCase().replace(/[\s()]/g, "");
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
        select: { id: true, questionNum: true, answer: true, syllabusTopic: true, marksAvailable: true },
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

  // Read pages from disk (faster than HTTP self-call).
  const allExtracted: ExtractedAnswer[] = [];
  const pageResults: Array<{ pageOneBased: number; count: number; error?: string }> = [];
  for (const oneBased of answerPages1Indexed) {
    const pageIdx = oneBased - 1;
    const pagePath = path.join(PAGES_DIR, paper.id, `page_${pageIdx}.jpg`);
    try {
      const bytes = await fs.readFile(pagePath);
      const rows = await extractKeyFromPage(bytes);
      allExtracted.push(...rows);
      pageResults.push({ pageOneBased: oneBased, count: rows.length });
    } catch (err) {
      pageResults.push({ pageOneBased: oneBased, count: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const extractedByNum = new Map<string, string>();
  for (const r of allExtracted) extractedByNum.set(normNum(r.questionNum), r.answer);

  type Diff = {
    qId: string;
    qNum: string;
    status: "match" | "minor" | "diff" | "missing-stored" | "missing-extracted";
    stored: string;
    extracted: string;
    topic: string | null;
    marks: number | null;
  };
  const diffs: Diff[] = [];
  for (const q of paper.questions) {
    const extracted = extractedByNum.get(normNum(q.questionNum));
    if (extracted == null) {
      if ((q.answer ?? "").trim()) {
        diffs.push({
          qId: q.id,
          qNum: q.questionNum,
          status: "missing-extracted",
          stored: q.answer ?? "",
          extracted: "",
          topic: q.syllabusTopic,
          marks: q.marksAvailable,
        });
      }
      continue;
    }
    const cls = classify(q.answer, extracted);
    diffs.push({
      qId: q.id,
      qNum: q.questionNum,
      status: cls,
      stored: q.answer ?? "",
      extracted,
      topic: q.syllabusTopic,
      marks: q.marksAvailable,
    });
  }

  // Counts.
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
    pageResults,
    questionCount: paper.questions.length,
    counts,
    diffs,
  });
}
