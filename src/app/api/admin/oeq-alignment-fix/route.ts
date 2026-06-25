// Science multipart OEQ alignment-fix API.
//
// GET  /api/admin/oeq-alignment-fix
//   → returns counts: total broken Qs, auto-fixable estimate (by
//     re-extracting in dry-run mode) capped at `?limit=N` (default 10).
//     Use ?count-only=1 to skip Gemini entirely and just return the
//     total-broken count for the dashboard.
//
// POST /api/admin/oeq-alignment-fix
//   body: { limit?: number, apply?: boolean }
//   → walks the broken-Q queue (capped at `limit`, default 10),
//     re-extracts each via Gemini, and either reports the proposed
//     changes (apply=false, dry-run) or writes them to the DB
//     (apply=true).
//
// Auth: admin session only.
//
// "Broken" = transcribedSubparts has a label that can't reach an answer
// through direct match OR compound-parent fallback (b-i → b).
//
// Auto-fix policy (same as scripts/fix-science-oeq-alignment.ts):
//   - new label set differs from old
//   - new label set has strictly fewer alignment-miss labels

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { transcribeScienceOpenEndedQuestion } from "@/lib/gemini";
import { parsePartAnswers } from "@/lib/marking";

type Subpart = { label: string; text?: string };

// Use the marker's parsePartAnswers — it's the SAME function the actual
// marker uses to attach answers to subparts. Reusing it here means our
// "is this question broken?" detection matches what the marker sees,
// so we don't surface false-positives where the answer key looks fine
// to the marker but our naive regex flags it.
//
// parsePartAnswers handles:
//   - "(a) X | (b) Y | (c) Z"           (pipe-separated)
//   - "(a) X. (b) Y. (c) Z."            (no pipes)
//   - "(a)(i) K (a)(ii) J | (b) ..."    (compound)
//   - "(a-i)" / "(a-ii)" hyphen forms
//   - Forward-walk relaxed scan for "(a) X (b) Y" without separators
function extractAnswerKeyLabels(answer: string | null): Set<string> {
  if (!answer) return new Set<string>();
  return new Set(parsePartAnswers(answer).keys());
}
function parseLabel(l: string): { parent: string } {
  const norm = l.toLowerCase();
  return norm.includes("-") ? { parent: norm.split("-")[0] } : { parent: norm };
}
function hasAlignmentBug(subs: Subpart[], answer: string | null): boolean {
  const real = subs.filter(s => s && !s.label.startsWith("_"));
  if (real.length < 2) return false;
  const keyLabels = extractAnswerKeyLabels(answer);
  const keyParents = new Set([...keyLabels].map(l => parseLabel(l).parent));
  const keyCompounds = new Set([...keyLabels].filter(l => l.includes("-")));
  for (const sp of real) {
    const sl = sp.label.toLowerCase();
    if (keyLabels.has(sl)) continue;
    if (sl.includes("-") && keyParents.has(parseLabel(sl).parent)) continue;
    if (!sl.includes("-") && [...keyCompounds].some(k => k.startsWith(`${sl}-`))) continue;
    return true;
  }
  return false;
}
function countMisses(labels: string[], keyLabels: Set<string>): number {
  const keyParents = new Set([...keyLabels].map(l => parseLabel(l).parent));
  return labels.filter(l => {
    if (keyLabels.has(l)) return false;
    if (l.includes("-") && keyParents.has(parseLabel(l).parent)) return false;
    return true;
  }).length;
}

async function findBroken() {
  const papers = await prisma.examPaper.findMany({
    where: { subject: { contains: "Science", mode: "insensitive" }, assignedToId: null },
    select: {
      id: true, title: true,
      questions: {
        select: { id: true, questionNum: true, transcribedSubparts: true, transcribedStem: true, answer: true, imageData: true },
      },
    },
  });
  const out: Array<{ paperId: string; paperTitle: string; questionId: string; questionNum: string; subs: Subpart[]; stem: string | null; answer: string | null; hasImage: boolean }> = [];
  for (const p of papers) {
    for (const q of p.questions) {
      const subs = q.transcribedSubparts as Subpart[] | null;
      if (!Array.isArray(subs)) continue;
      if (!hasAlignmentBug(subs, q.answer)) continue;
      out.push({
        paperId: p.id,
        paperTitle: p.title,
        questionId: q.id,
        questionNum: q.questionNum,
        subs: subs.filter(s => s && !s.label.startsWith("_")),
        stem: q.transcribedStem,
        answer: q.answer,
        hasImage: !!q.imageData,
      });
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const countOnly = req.nextUrl.searchParams.get("count-only") === "1";
  const broken = await findBroken();
  if (countOnly) {
    return NextResponse.json({ totalBroken: broken.length });
  }
  // For dashboard preview: just return shape + counts without firing Gemini.
  return NextResponse.json({
    totalBroken: broken.length,
    papers: [...new Set(broken.map(b => b.paperId))].length,
  });
}

export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { limit?: number; apply?: boolean };
  const limit = Math.max(1, Math.min(50, body.limit ?? 10));
  const apply = !!body.apply;

  const broken = await findBroken();
  const queue = broken.slice(0, limit);

  type Proposal = {
    paperId: string;
    paperTitle: string;
    questionId: string;
    questionNum: string;
    oldLabels: string[];
    newLabels: string[];
    oldStem: string | null;
    newStem: string | null;
    oldSubparts: Subpart[];
    newSubparts: Subpart[];
    oldAnswer: string | null;
    oldMisses: number;
    newMisses: number;
    verdict: "improve" | "no-change" | "no-image" | "error";
    error?: string;
    applied?: boolean;
    // Question image as data URL so the admin can visually verify
    // Gemini's proposed re-extract against the actual scanned question.
    imageDataUrl: string | null;
  };

  async function processOne(b: typeof queue[number]): Promise<Proposal> {
    if (!b.hasImage) {
      return {
        paperId: b.paperId, paperTitle: b.paperTitle, questionId: b.questionId,
        questionNum: b.questionNum,
        oldLabels: b.subs.map(s => s.label.toLowerCase()),
        newLabels: [],
        oldStem: b.stem, newStem: null,
        oldSubparts: b.subs, newSubparts: [],
        oldAnswer: b.answer,
        oldMisses: -1, newMisses: -1,
        verdict: "no-image",
        imageDataUrl: null,
      };
    }
    const q = await prisma.examQuestion.findUnique({ where: { id: b.questionId }, select: { imageData: true } });
    if (!q?.imageData) {
      return {
        paperId: b.paperId, paperTitle: b.paperTitle, questionId: b.questionId,
        questionNum: b.questionNum,
        oldLabels: b.subs.map(s => s.label.toLowerCase()),
        newLabels: [],
        oldStem: b.stem, newStem: null,
        oldSubparts: b.subs, newSubparts: [],
        oldAnswer: b.answer,
        oldMisses: -1, newMisses: -1,
        verdict: "no-image",
        imageDataUrl: null,
      };
    }
    const imageDataUrl = q.imageData.startsWith("data:") ? q.imageData : `data:image/jpeg;base64,${q.imageData}`;
    const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
    let result;
    try {
      result = await transcribeScienceOpenEndedQuestion(base64);
    } catch (err) {
      return {
        paperId: b.paperId, paperTitle: b.paperTitle, questionId: b.questionId,
        questionNum: b.questionNum,
        oldLabels: b.subs.map(s => s.label.toLowerCase()),
        newLabels: [],
        oldStem: b.stem, newStem: null,
        oldSubparts: b.subs, newSubparts: [],
        oldAnswer: b.answer,
        oldMisses: -1, newMisses: -1,
        verdict: "error",
        error: (err as Error).message,
        imageDataUrl,
      };
    }
    const newSubs: Subpart[] = (result.subparts ?? []).map(s => ({ label: s.label, text: s.text }));
    const oldLabels = b.subs.map(s => s.label.toLowerCase());
    const newLabels = newSubs.map(s => s.label.toLowerCase());
    const keyLabels = extractAnswerKeyLabels(b.answer);
    const oldMisses = countMisses(oldLabels, keyLabels);
    const newMisses = countMisses(newLabels, keyLabels);
    const labelsChanged = oldLabels.join(",") !== newLabels.join(",");
    const verdict: "improve" | "no-change" = (labelsChanged && newMisses < oldMisses) ? "improve" : "no-change";
    let applied = false;
    if (apply && verdict === "improve") {
      await prisma.examQuestion.update({
        where: { id: b.questionId },
        data: { transcribedSubparts: newSubs as never },
      });
      applied = true;
    }
    return {
      paperId: b.paperId, paperTitle: b.paperTitle, questionId: b.questionId,
      questionNum: b.questionNum,
      oldLabels, newLabels,
      oldStem: b.stem, newStem: result.stem ?? null,
      oldSubparts: b.subs, newSubparts: newSubs,
      oldAnswer: b.answer,
      oldMisses, newMisses,
      verdict,
      applied,
      imageDataUrl,
    };
  }

  // Sliding-window concurrency. Sequential was hitting Cloudflare 524s
  // (10 × ~7s per Gemini call ≈ 70s, plus DB I/O) — admin never saw
  // the samples. Run 5 at a time: keeps Gemini quota happy and brings
  // the dry-run inside the 100s timeout for typical limit values.
  const CONCURRENCY = 5;
  const proposals: Proposal[] = new Array(queue.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= queue.length) return;
      proposals[i] = await processOne(queue[i]);
    }
  });
  await Promise.all(workers);

  return NextResponse.json({
    totalBroken: broken.length,
    processed: proposals.length,
    improvable: proposals.filter(p => p.verdict === "improve").length,
    applied: proposals.filter(p => p.applied).length,
    proposals,
  });
}
