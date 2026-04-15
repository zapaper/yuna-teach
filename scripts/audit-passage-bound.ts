// Audit passage-bound English Q&A (Grammar Cloze, Editing, Comprehension Cloze)
// against the shared passage — sends one batch per section, not per question.
//
// Run:  npx tsx scripts/audit-passage-bound.ts

import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";

async function main() {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "english", mode: "insensitive" },
      },
      OR: [
        { syllabusTopic: { contains: "grammar cloze", mode: "insensitive" } },
        { syllabusTopic: { contains: "editing", mode: "insensitive" } },
        { syllabusTopic: { contains: "comprehension cloze", mode: "insensitive" } },
      ],
      answer: { not: null },
    },
    select: {
      id: true,
      questionNum: true,
      syllabusTopic: true,
      transcribedSubparts: true,
      answer: true,
      examPaper: { select: { title: true, metadata: true } },
    },
    orderBy: [{ examPaperId: "asc" }, { orderIndex: "asc" }],
  });

  const bySec: Record<string, typeof rows> = {};
  for (const r of rows) {
    const key = r.examPaper.title + "::" + r.syllabusTopic;
    (bySec[key] ??= []).push(r);
  }

  console.log(`Auditing ${Object.keys(bySec).length} sections (${rows.length} questions total)\n`);

  const flagged: { reason: string; row: typeof rows[number] }[] = [];
  const keys = Object.keys(bySec);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const rs = bySec[key];
    const first = rs[0];
    const subs = first.transcribedSubparts as Array<{ label: string; text: string }> | null;
    let passage = subs?.find(s => s.label === "_passage")?.text ?? "";
    if (!passage) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (first.examPaper.metadata ?? {}) as any;
      const secs = meta.sectionOcrTexts ?? {};
      const hit = Object.entries(secs).find(([k]) =>
        (k as string).toLowerCase().replace(/\s+/g, "") ===
        (first.syllabusTopic ?? "").toLowerCase().replace(/\s+/g, "")
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (hit) passage = ((hit[1] as any)?.ocrText ?? "") as string;
    }
    if (!passage) {
      console.log(`[${i + 1}/${keys.length}] SKIP (no passage): ${key}`);
      continue;
    }

    const list = rs.map(r => `  Q${r.questionNum}: answer key = ${r.answer}`).join("\n");
    const prompt = `Audit these passage-bound English answer keys against the shared passage.

Section: ${first.syllabusTopic}
Paper: ${first.examPaper.title}

PASSAGE (numbered blanks appear inline as (N) or **(N) word**):
${passage.slice(0, 4000)}

QUESTIONS:
${list}

For each question, judge whether the given answer key is grammatically and semantically correct for that numbered blank. Be strict on clear mismatches (wrong word form, contradicts the sentence meaning, wrong letter from a word bank that doesn't match any option). Be lenient on minor style differences. For Editing, the answer is the CORRECTED word for an error in the passage — accept any spelling fix that matches the intended correct word.

Return ONLY JSON: {"issues":[{"questionNum":"N","reason":"<one sentence>"}]}
If all ok: {"issues":[]}`;

    try {
      const resp = await generateContentWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0 },
      });
      const parsed = JSON.parse(resp.text ?? "{}") as { issues?: { questionNum: string; reason: string }[] };
      const issues = parsed.issues ?? [];
      console.log(`[${i + 1}/${keys.length}] ${key} → ${issues.length} flagged`);
      for (const iss of issues) {
        const row = rs.find(r => r.questionNum === iss.questionNum);
        if (row) flagged.push({ reason: iss.reason, row });
      }
    } catch (err) {
      console.log(`[${i + 1}/${keys.length}] ERROR on ${key}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n=== ${flagged.length} potentially wrong passage-bound Q&A ===\n`);
  const byPaper: Record<string, typeof flagged> = {};
  for (const f of flagged) {
    (byPaper[f.row.examPaper.title] ??= []).push(f);
  }
  for (const [paper, items] of Object.entries(byPaper)) {
    console.log(`\n## ${paper}`);
    for (const it of items) {
      console.log(`  - [${it.row.syllabusTopic}] Q${it.row.questionNum} answer=${it.row.answer}`);
      console.log(`    id=${it.row.id}`);
      console.log(`    ⚠  ${it.reason}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
