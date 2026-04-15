// Audit Science Q&A for obviously wrong answer keys.
// Run:  npx tsx scripts/audit-science-qa.ts

import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";

const BATCH = 8;

function briefStem(s: string | null, max = 500): string {
  if (!s) return "";
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function formatOptions(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw.map((o, i) => `  (${i + 1}) ${String(o)}`).join("\n");
}

function formatSubparts(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .filter((sp): sp is { label: string; text: string } => !!sp && typeof sp === "object" && "label" in sp && !String((sp as { label: string }).label).startsWith("_"))
    .map(sp => `  (${sp.label}) ${sp.text}`)
    .join("\n");
}

type Row = {
  id: string;
  questionNum: string;
  syllabusTopic: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  transcribedSubparts: unknown;
  answer: string | null;
  examPaper: { title: string; school: string | null; year: string | null; examType: string | null; level: string | null };
};

function fullPaperTitle(p: Row["examPaper"]): string {
  return [p.level, "Science", p.examType, p.school, p.year].filter(Boolean).join(" · ") || p.title;
}

async function auditBatch(rows: Row[]): Promise<{ id: string; reason: string }[]> {
  const items = rows.map((q, i) => {
    const opts = formatOptions(q.transcribedOptions);
    const subs = formatSubparts(q.transcribedSubparts);
    const isMcq = !!opts;
    return [
      `[${i}] id=${q.id}`,
      `Type: ${isMcq ? "MCQ" : "OEQ"}`,
      `Topic: ${q.syllabusTopic}`,
      `Paper: ${fullPaperTitle(q.examPaper)}`,
      `Stem: ${briefStem(q.transcribedStem)}`,
      opts ? `Options:\n${opts}` : "",
      subs ? `Sub-parts:\n${subs}` : "",
      `Answer key: ${q.answer ?? "(null)"}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");

  const prompt = `You are auditing a Singapore primary-school Science Q&A answer key. You see the TEXT of each question — diagrams, option images, tables and graphs are shown to the STUDENT separately and are NOT visible to you.

IMPORTANT — do NOT flag any of the following as problems:
- "diagram missing", "graph missing", "table missing", "flowchart missing"
- "options missing" when Type is MCQ — options exist separately, you just don't see them
- Stems that reference labelled figures ("organism Q", "position X", "graph below") — they are shown to the student
- Multiple valid OEQ phrasings; partial answers that hit the key scientific concept
- Minor wording / spelling in OEQ answers
- Sub-parts where only the combined answer is given

Flag ONLY clear scientific or logical mismatches:
- OEQ answer contradicts basic Primary-school science principles or doesn't address what the stem asks
- OEQ answer contains an internal contradiction or a self-refuting statement
- Answer key is labelled for a different sub-part than the question asks
- Answer key references a name / entity that doesn't match the stem (copy-paste error)
- MCQ answer clearly wrong judging by the question text alone
- Answer uses a format the stem does NOT ask for (e.g. list of parts when asked for an arrow diagram)

For MCQ, answer key is "1"/"2"/"3"/"4" (or "(1)" etc.).

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
    const parsed = JSON.parse(resp.text ?? "{}") as { issues?: { idx: number; id: string; reason: string }[] };
    return (parsed.issues ?? []).map(i => ({ id: i.id || rows[i.idx]?.id, reason: i.reason }));
  } catch (err) {
    console.error("Batch failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

async function main() {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "science", mode: "insensitive" },
      },
      transcribedStem: { not: null },
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
      examPaper: { select: { title: true, school: true, year: true, examType: true, level: true } },
    },
    orderBy: [{ examPaperId: "asc" }, { orderIndex: "asc" }],
  });

  console.log(`Auditing ${rows.length} Science questions in batches of ${BATCH}…\n`);

  const allIssues: { row: Row; reason: string }[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const issues = await auditBatch(batch);
    console.log(`Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(rows.length / BATCH)} → ${issues.length} flagged`);
    for (const iss of issues) {
      const row = rows.find(r => r.id === iss.id);
      if (row) allIssues.push({ row, reason: iss.reason });
    }
  }

  console.log(`\n=== ${allIssues.length} potentially wrong Science Q&A ===\n`);
  const byPaper: Record<string, typeof allIssues> = {};
  for (const it of allIssues) {
    (byPaper[fullPaperTitle(it.row.examPaper)] ??= []).push(it);
  }
  for (const [paper, items] of Object.entries(byPaper)) {
    console.log(`\n## ${paper}`);
    for (const it of items) {
      console.log(`  - [${it.row.syllabusTopic}] Q${it.row.questionNum}`);
      console.log(`    Stem: ${briefStem(it.row.transcribedStem, 160)}`);
      console.log(`    Answer: ${it.row.answer}`);
      console.log(`    ⚠  ${it.reason}`);
      console.log(`    id=${it.row.id}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
