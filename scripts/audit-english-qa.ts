// Audit English Q&A (all non-comprehension topics) for obviously wrong answer keys.
// Sends batches to Gemini and asks it to flag any question where the answer key
// doesn't match the stem / options.
//
// Run:  npx tsx scripts/audit-english-qa.ts

import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";

type Row = {
  id: string;
  questionNum: string;
  syllabusTopic: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  transcribedSubparts: unknown;
  answer: string | null;
  examPaper: { id: string; title: string; metadata: unknown };
};

function isPassageBound(topic: string | null | undefined): boolean {
  const t = (topic ?? "").toLowerCase();
  return t.includes("grammar cloze") || t.includes("editing") ||
    (t.includes("comprehension") && t.includes("cloze"));
}

// For passage-bound questions, rebuild the "stem" as the passage + the specific blank.
// Pulls sectionOcrText from paper metadata or from the question's _passage subpart.
function enrichedStem(q: Row): string {
  if (!isPassageBound(q.syllabusTopic)) return q.transcribedStem ?? "";
  // 1) Try _passage sentinel subpart
  const subs = q.transcribedSubparts as Array<{ label: string; text: string }> | null;
  let passage = subs?.find(sp => sp.label === "_passage")?.text ?? "";
  // 2) Fall back to paper metadata.sectionOcrTexts[topic].ocrText
  if (!passage && q.syllabusTopic) {
    const meta = (q.examPaper.metadata ?? {}) as { sectionOcrTexts?: Record<string, { ocrText?: string }> };
    const secs = meta.sectionOcrTexts ?? {};
    const hit = Object.entries(secs).find(([k]) => k.toLowerCase().replace(/\s+/g, "") === q.syllabusTopic!.toLowerCase().replace(/\s+/g, ""));
    if (hit) passage = hit[1]?.ocrText ?? "";
  }
  const label = `(For ${q.syllabusTopic}, the "stem" is a numbered blank in the shared passage below. Judge whether the answer key is a plausible fill for blank (${q.questionNum}).)`;
  return [label, passage ? `PASSAGE:\n${passage}` : "(no passage available)"].join("\n");
}

const BATCH = 10;

function briefStem(s: string | null, max = 400): string {
  if (!s) return "";
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function formatOptions(raw: unknown): string {
  if (!raw) return "";
  if (!Array.isArray(raw)) return "";
  return raw.map((o, i) => `  (${i + 1}) ${String(o)}`).join("\n");
}

function formatSubparts(raw: unknown): string {
  if (!raw || !Array.isArray(raw)) return "";
  return raw
    .filter((sp): sp is { label: string; text: string } => !!sp && typeof sp === "object" && "label" in sp && !String((sp as { label: string }).label).startsWith("_"))
    .map(sp => `  (${sp.label}) ${sp.text}`)
    .join("\n");
}

async function auditBatch(rows: Row[]): Promise<{ id: string; reason: string }[]> {
  const items = rows.map((q, i) => {
    const opts = formatOptions(q.transcribedOptions);
    const subs = formatSubparts(q.transcribedSubparts);
    const stemText = isPassageBound(q.syllabusTopic)
      ? briefStem(enrichedStem(q), 1600)
      : briefStem(q.transcribedStem);
    return [
      `[${i}] id=${q.id}`,
      `Topic: ${q.syllabusTopic}`,
      `Paper: ${q.examPaper.title}`,
      `Stem: ${stemText}`,
      opts ? `Options:\n${opts}` : "",
      subs && !isPassageBound(q.syllabusTopic) ? `Sub-parts:\n${subs}` : "",
      `Answer key: ${q.answer ?? "(null)"}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");

  const prompt = `You are auditing a primary-school English Q&A answer key. For each item below, judge whether the answer key is plausible/correct given the stem + options (if present).

Be STRICT on clear mismatches (answer doesn't match the stem's grammar, wrong tense, wrong word class, obviously wrong option number, meaningless word, name spelled differently from the stem). Be LENIENT on minor style differences or when two answers could both work. If the stem is truncated or unclear, err on "ok".

IMPORTANT — do NOT flag a question as bad just because the per-question stem is empty for Grammar Cloze, Editing, or Comprehension Cloze. In those sections, each question is just a numbered blank inside the shared passage (provided above the blank when available). Judge the answer against the passage + blank number.

For Grammar/Vocab MCQ, answer key is 1|2|3|4. For Grammar Cloze, it's a letter A–Q selected from a word bank. For Editing, it's the corrected word. For Synthesis, it's the rewritten sentence or sentence fragment. For Vocab Cloze MCQ, 1–4.

Return ONLY valid JSON of this shape (no prose, no markdown):
{"issues":[{"idx":0,"id":"<id>","reason":"<one sentence>"}]}

If everything in the batch looks fine, return {"issues":[]}.

Items:
${items}`;

  try {
    const resp = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const text = resp.text ?? "";
    const parsed = JSON.parse(text) as { issues: { idx: number; id: string; reason: string }[] };
    return (parsed.issues ?? []).map(i => ({ id: i.id || rows[i.idx]?.id, reason: i.reason }));
  } catch (err) {
    console.error("Batch failed:", err);
    return [];
  }
}

async function main() {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "english", mode: "insensitive" },
      },
      NOT: { syllabusTopic: { contains: "comprehension", mode: "insensitive" } },
      answer: { not: null },
    },
    select: {
      id: true,
      questionNum: true,
      syllabusTopic: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedSubparts: true,
      answer: true,
      examPaper: { select: { id: true, title: true, metadata: true } },
    },
    orderBy: [{ examPaperId: "asc" }, { orderIndex: "asc" }],
  });

  console.log(`Auditing ${rows.length} English questions in batches of ${BATCH}…\n`);

  const allIssues: { row: Row; reason: string }[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    process.stdout.write(`Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(rows.length / BATCH)} `);
    const issues = await auditBatch(batch);
    process.stdout.write(`→ ${issues.length} flagged\n`);
    for (const iss of issues) {
      const row = rows.find(r => r.id === iss.id);
      if (row) allIssues.push({ row, reason: iss.reason });
    }
  }

  console.log(`\n=== ${allIssues.length} potentially bad Q&A ===\n`);
  const byPaper: Record<string, { row: Row; reason: string }[]> = {};
  for (const it of allIssues) {
    const k = it.row.examPaper.title;
    (byPaper[k] ??= []).push(it);
  }
  for (const [paper, items] of Object.entries(byPaper)) {
    console.log(`\n## ${paper}`);
    for (const it of items) {
      console.log(`  - [${it.row.syllabusTopic}] Q${it.row.questionNum} id=${it.row.id}`);
      console.log(`    Stem: ${briefStem(it.row.transcribedStem, 160)}`);
      console.log(`    Answer: ${it.row.answer}`);
      console.log(`    ⚠  ${it.reason}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
