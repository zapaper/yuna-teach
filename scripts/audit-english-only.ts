// Quick English-only thorough audit — 1 question per AI call.
// Run:  npx tsx scripts/audit-english-only.ts

import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";

function isPassageBound(topic: string | null): boolean {
  const t = (topic ?? "").toLowerCase();
  return t.includes("grammar cloze") || t.includes("editing") || (t.includes("comprehension") && t.includes("cloze"));
}

async function main() {
  const rows = await prisma.examQuestion.findMany({
    where: {
      answer: { not: null },
      examPaper: { sourceExamId: null, paperType: null, subject: { contains: "english", mode: "insensitive" } },
      NOT: { syllabusTopic: { contains: "comprehension", mode: "insensitive" } },
    },
    select: {
      id: true, questionNum: true, syllabusTopic: true,
      transcribedStem: true, transcribedOptions: true, transcribedSubparts: true,
      answer: true,
      examPaper: { select: { title: true, school: true, level: true, year: true, examType: true, metadata: true } },
    },
    orderBy: [{ examPaperId: "asc" }, { orderIndex: "asc" }],
  });

  console.log(`Auditing ${rows.length} English questions…\n`);
  type Issue = { paper: string; qnum: string; topic: string; answer: string; reason: string };
  const issues: Issue[] = [];

  for (let i = 0; i < rows.length; i++) {
    const q = rows[i];
    const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as string[]).map((o, j) => `(${j+1}) ${o}`).join(" | ") : "";
    const subs = Array.isArray(q.transcribedSubparts) ? (q.transcribedSubparts as Array<{label:string;text:string}>).filter(s => !s.label.startsWith("_")).map(s => `(${s.label}) ${s.text}`).join(" | ") : "";
    const pb = isPassageBound(q.syllabusTopic);
    let passage = "";
    if (pb) {
      const ss = q.transcribedSubparts as Array<{label:string;text:string}> | null;
      passage = ss?.find(s => s.label === "_passage")?.text ?? "";
      if (!passage) {
        const meta = (q.examPaper.metadata ?? {}) as any;
        const secs = meta.sectionOcrTexts ?? {};
        const hit = Object.entries(secs).find(([k]) => (k as string).toLowerCase().replace(/\s+/g,"") === (q.syllabusTopic ?? "").toLowerCase().replace(/\s+/g,""));
        if (hit) passage = ((hit[1] as any)?.ocrText ?? "") as string;
      }
      passage = passage.slice(0, 2000);
    }
    const stem = pb && !q.transcribedStem ? `(Passage-bound blank ${q.questionNum})` : (q.transcribedStem ?? "(no stem)").slice(0, 600);
    const fullTitle = [q.examPaper.level, q.examPaper.examType, q.examPaper.school, q.examPaper.year].filter(Boolean).join(" · ") || q.examPaper.title;

    const prompt = `You are auditing ONE primary-school English exam question. Check if the answer key is correct.

Question ${q.questionNum} [${q.syllabusTopic ?? "?"}]
Paper: ${fullTitle}
Stem: ${stem}
${opts ? `Options: ${opts}` : ""}${subs ? `\nSub-parts: ${subs}` : ""}${passage ? `\nPassage:\n${passage}` : ""}
Answer key: ${q.answer}

Check for: wrong grammar, wrong option, typo/name mismatch, wrong tense, sub-part label error, answer doesn't fit the blank.
For Grammar Cloze (letter A-Q), verify the letter maps to a fitting word.
For Editing, verify the corrected word fixes the error.
For Synthesis, verify the rewrite preserves meaning with the keyword.

Return ONLY JSON:
- Correct: {"ok": true}
- Problem: {"ok": false, "reason": "<one sentence>"}`;

    try {
      const resp = await generateContentWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0 },
      });
      const parsed = JSON.parse(resp.text ?? "{}") as { ok: boolean; reason?: string };
      if (!parsed.ok && parsed.reason) {
        issues.push({ paper: fullTitle, qnum: q.questionNum, topic: q.syllabusTopic ?? "", answer: q.answer ?? "", reason: parsed.reason });
      }
    } catch {}
    if ((i + 1) % 20 === 0) process.stdout.write(`\r  ${i + 1}/${rows.length} (${issues.length} flagged)`);
  }
  console.log(`\n\n=== ${issues.length} English issues ===\n`);
  const byPaper: Record<string, Issue[]> = {};
  for (const it of issues) (byPaper[it.paper] ??= []).push(it);
  for (const [paper, its] of Object.entries(byPaper)) {
    console.log(`## ${paper}`);
    for (const it of its) console.log(`  Q${it.qnum} [${it.topic}] ans="${it.answer}"\n    ⚠ ${it.reason}`);
    console.log("");
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
