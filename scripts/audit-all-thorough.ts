// Thorough per-question Q&A audit for Math, Science, English.
// Sends ONE question per AI call so the model focuses entirely on it.
// Run:  npx tsx scripts/audit-all-thorough.ts
// Output: JSON file at scripts/audit-results-{timestamp}.json

import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";

function briefStem(s: string | null, max = 600): string {
  if (!s) return "";
  return s.trim().replace(/\s+/g, " ").slice(0, max);
}
function fmtOpts(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw.map((o, i) => `(${i + 1}) ${String(o)}`).join(" | ");
}
function fmtSubs(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .filter((sp): sp is { label: string; text: string } => !!sp && typeof sp === "object" && "label" in sp && !String((sp as { label: string }).label).startsWith("_"))
    .map(sp => `(${sp.label}) ${sp.text}`)
    .join(" | ");
}
function isPassageBound(topic: string | null): boolean {
  const t = (topic ?? "").toLowerCase();
  return t.includes("grammar cloze") || t.includes("editing") || (t.includes("comprehension") && t.includes("cloze"));
}

type Row = {
  id: string;
  questionNum: string;
  syllabusTopic: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  transcribedSubparts: unknown;
  answer: string | null;
  examPaper: { title: string; school: string | null; level: string | null; year: string | null; examType: string | null; metadata: unknown };
};

type Issue = { id: string; paper: string; qnum: string; topic: string; answer: string; reason: string };

function getPassage(q: Row): string {
  if (!isPassageBound(q.syllabusTopic)) return "";
  const subs = q.transcribedSubparts as Array<{ label: string; text: string }> | null;
  let passage = subs?.find(s => s.label === "_passage")?.text ?? "";
  if (!passage) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (q.examPaper.metadata ?? {}) as any;
    const secs = meta.sectionOcrTexts ?? {};
    const hit = Object.entries(secs).find(([k]) =>
      (k as string).toLowerCase().replace(/\s+/g, "") === (q.syllabusTopic ?? "").toLowerCase().replace(/\s+/g, "")
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (hit) passage = ((hit[1] as any)?.ocrText ?? "") as string;
  }
  return passage.slice(0, 2000);
}

function fullTitle(p: Row["examPaper"]): string {
  return [p.level, p.examType, p.school, p.year].filter(Boolean).join(" · ") || p.title;
}

async function auditOne(q: Row, subject: string): Promise<Issue | null> {
  const opts = fmtOpts(q.transcribedOptions);
  const subs = fmtSubs(q.transcribedSubparts);
  const passage = getPassage(q);
  const isMcq = !!opts;
  const passageBound = isPassageBound(q.syllabusTopic);

  let stemInfo: string;
  if (passageBound && !q.transcribedStem) {
    stemInfo = `(This is a passage-bound blank — blank (${q.questionNum}) sits inside the passage below.)`;
  } else {
    stemInfo = briefStem(q.transcribedStem) || "(no stem text)";
  }

  const subjectGuide = subject === "math"
    ? `For Math: check arithmetic logic, formula correctness, unit consistency. For MCQ, verify the selected option answers the question correctly. For OEQ, verify the worked solution is mathematically sound.`
    : subject === "science"
    ? `For Science: check scientific accuracy at Primary school level. Diagrams/tables may exist but are not shown to you — do NOT flag 'diagram missing' or 'options missing'. For MCQ answer keys, only flag if the question text alone reveals the answer is wrong.`
    : `For English: check grammar, spelling, meaning, capitalization. For Grammar Cloze (letter answers A-Q), verify the letter maps to a word that fits. For Editing, verify the corrected word fixes the error. For Synthesis, verify the rewrite preserves meaning and uses the keyword. For Vocab Cloze MCQ, verify the option matches the underlined word's meaning.`;

  const prompt = `You are auditing ONE primary-school ${subject} exam question. Check if the answer key is correct and plausible.

${subjectGuide}

Question ${q.questionNum} [${q.syllabusTopic ?? "?"}]
Paper: ${fullTitle(q.examPaper)}
${isMcq ? "Type: MCQ" : "Type: OEQ"}
Stem: ${stemInfo}
${opts ? `Options: ${opts}` : ""}
${subs ? `Sub-parts: ${subs}` : ""}
${passage ? `Passage context:\n${passage}\n` : ""}
Answer key: ${q.answer}

Is the answer key correct? Check for:
- Wrong answer (scientifically/mathematically/grammatically incorrect)
- Answer doesn't match the question asked
- Typos or name mismatches between stem and answer
- Wrong option number for MCQ
- Sub-part label mismatch (e.g. answer for (c) labelled as (b))
- Self-contradicting explanation in OEQ answers
- For passage-bound: answer doesn't fit the blank in context

Return ONLY JSON:
- If the answer key looks correct: {"ok": true}
- If there is a problem: {"ok": false, "reason": "<one clear sentence explaining the specific error>"}`;

  try {
    const resp = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const text = resp.text ?? "";
    const parsed = JSON.parse(text) as { ok: boolean; reason?: string };
    if (!parsed.ok && parsed.reason) {
      return {
        id: q.id,
        paper: fullTitle(q.examPaper),
        qnum: q.questionNum,
        topic: q.syllabusTopic ?? "",
        answer: q.answer ?? "",
        reason: parsed.reason,
      };
    }
  } catch (err) {
    console.warn(`  Q${q.questionNum} AI call failed:`, err instanceof Error ? err.message : err);
  }
  return null;
}

async function auditSubject(subject: string): Promise<Issue[]> {
  const where = subject === "english"
    ? {
        answer: { not: null as null },
        examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" as const } },
        NOT: { syllabusTopic: { contains: "comprehension", mode: "insensitive" as const } },
      }
    : {
        transcribedStem: { not: null as null },
        answer: { not: null as null },
        examPaper: { sourceExamId: null, paperType: null, subject: { contains: subject, mode: "insensitive" as const } },
      };

  const rows: Row[] = await prisma.examQuestion.findMany({
    where,
    select: {
      id: true, questionNum: true, syllabusTopic: true,
      transcribedStem: true, transcribedOptions: true, transcribedSubparts: true,
      answer: true,
      examPaper: { select: { title: true, school: true, level: true, year: true, examType: true, metadata: true } },
    },
    orderBy: [{ examPaperId: "asc" }, { orderIndex: "asc" }],
  });

  console.log(`\n[${ subject.toUpperCase() }] Auditing ${rows.length} questions (1 per AI call)…`);
  const issues: Issue[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(q => auditOne(q, subject)));
    for (const r of results) {
      if (r) issues.push(r);
    }
    const done = Math.min(i + CONCURRENCY, rows.length);
    process.stdout.write(`\r  ${done}/${rows.length} (${issues.length} flagged)`);
  }
  console.log(`\n[${subject.toUpperCase()}] Done: ${issues.length} flagged out of ${rows.length}`);
  return issues;
}

async function main() {
  const [math, science, english] = await Promise.all([
    auditSubject("math"),
    auditSubject("science"),
    auditSubject("english"),
  ]);

  const all = { math, science, english, timestamp: new Date().toISOString() };
  const outPath = `scripts/audit-results-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  const fs = await import("fs");
  fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
  console.log(`\nResults written to ${outPath}`);

  // Print summary
  for (const [subj, items] of Object.entries({ math, science, english })) {
    if (items.length === 0) { console.log(`\n${subj.toUpperCase()}: all clear`); continue; }
    console.log(`\n=== ${subj.toUpperCase()}: ${items.length} issues ===`);
    const byPaper: Record<string, Issue[]> = {};
    for (const it of items) (byPaper[it.paper] ??= []).push(it);
    for (const [paper, its] of Object.entries(byPaper)) {
      console.log(`\n## ${paper}`);
      for (const it of its) {
        console.log(`  Q${it.qnum} [${it.topic}] ans="${it.answer}"`);
        console.log(`    ⚠ ${it.reason}`);
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
