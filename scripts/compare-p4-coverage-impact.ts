// Compare PSLE coverage BEFORE (P5+P6) vs AFTER (P4+P5+P6) adding the
// P4 wordlist. For each PSLE section, report:
//   - Distinct wordlist words appearing (before/after)
//   - Δ added by P4
//
// Also: which of the 16 PSLE-tested 成语 does P4 newly cover?

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type RawLesson = { lessonNumber: string | null; recogniseWords: string[]; writeWords: string[]; collocations: string[] };

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }

const PSLE_TESTED_IDIOMS_16 = [
  "目不转睛", "一言为定", "神机妙算", "异口同声", "恍然大悟",
  "垂头丧气", "左思右想", "不慌不忙", "五彩缤纷", "津津有味",
  "眉开眼笑", "手舞足蹈", "齐心协力", "获益不浅", "加油打气", "反败为胜",
];

function loadWords(jsonPath: string): Set<string> {
  if (!fs.existsSync(jsonPath)) return new Set();
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { lessons: RawLesson[] };
  const out = new Set<string>();
  for (const r of data.lessons) {
    for (const w of [...r.recogniseWords, ...r.writeWords, ...r.collocations]) {
      if (cjk(w).length >= 2) out.add(w);
    }
  }
  return out;
}

(async () => {
  const p4 = loadWords(path.join(__dirname, "p4-spelling-list.json"));
  const p5 = loadWords(path.join(__dirname, "p5-spelling-list.json"));
  const p6 = loadWords(path.join(__dirname, "p6-spelling-list.json"));

  const beforeSet = new Set([...p5, ...p6]);
  const afterSet = new Set([...p4, ...p5, ...p6]);
  const p4OnlyAdditions = [...p4].filter(w => !p5.has(w) && !p6.has(w));

  console.log(`P4 wordlist (≥2 CJK chars): ${p4.size}`);
  console.log(`P5 wordlist (≥2 CJK chars): ${p5.size}`);
  console.log(`P6 wordlist (≥2 CJK chars): ${p6.size}`);
  console.log(`Before (P5+P6): ${beforeSet.size}`);
  console.log(`After  (P4+P5+P6): ${afterSet.size}`);
  console.log(`P4-only additions (not in P5 or P6): ${p4OnlyAdditions.length}`);

  // ─── Pull PSLE corpus ─────────────────────────────────────────────
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { equals: "PSLE", mode: "insensitive" } }],
      subject: { contains: "chinese", mode: "insensitive" },
      sourceExamId: null, paperType: null,
    },
    select: { id: true },
  });
  const questions = await prisma.examQuestion.findMany({
    where: { examPaperId: { in: papers.map(p => p.id) } },
    select: {
      questionNum: true, syllabusTopic: true,
      transcribedStem: true, transcribedOptions: true, transcribedSubparts: true, answer: true,
    },
  });

  function questionText(q: typeof questions[number]): string {
    const parts: string[] = [];
    if (q.transcribedStem) parts.push(q.transcribedStem);
    if (Array.isArray(q.transcribedOptions)) parts.push((q.transcribedOptions as unknown[]).map(o => String(o ?? "")).join(" "));
    if (Array.isArray(q.transcribedSubparts)) {
      for (const s of q.transcribedSubparts as Array<{ text?: string }>) if (s?.text) parts.push(String(s.text));
    }
    if (q.answer) parts.push(q.answer);
    return parts.join(" ");
  }

  // For each section, count distinct words from BEFORE vs AFTER that appear in any question of that section.
  type Bucket = { section: string; questions: Array<typeof questions[number]> };
  const sections = new Map<string, Bucket>();
  for (const q of questions) {
    const s = q.syllabusTopic ?? "?";
    const b = sections.get(s) ?? { section: s, questions: [] };
    b.questions.push(q);
    sections.set(s, b);
  }

  function coverage(wordSet: Set<string>, qs: typeof questions): Set<string> {
    const hit = new Set<string>();
    const wordsArr = [...wordSet].filter(w => cjk(w).length >= 2);
    for (const q of qs) {
      const txt = questionText(q);
      if (!txt) continue;
      for (const w of wordsArr) if (txt.includes(w)) hit.add(w);
    }
    return hit;
  }

  console.log(`\n=== PSLE coverage by section ===\n`);
  const rows: Array<{ section: string; before: number; after: number; delta: number; p4Only: string[] }> = [];
  for (const [section, bucket] of sections.entries()) {
    const beforeHits = coverage(beforeSet, bucket.questions);
    const afterHits = coverage(afterSet, bucket.questions);
    const p4OnlyHits = [...afterHits].filter(w => !beforeHits.has(w));
    rows.push({
      section,
      before: beforeHits.size,
      after: afterHits.size,
      delta: afterHits.size - beforeHits.size,
      p4Only: p4OnlyHits,
    });
  }
  rows.sort((a, b) => b.delta - a.delta);
  for (const r of rows) {
    console.log(`  ${r.section.padEnd(20)}  ${String(r.before).padStart(4)} → ${String(r.after).padStart(4)} (+${r.delta})`);
    if (r.p4Only.length > 0 && r.p4Only.length <= 30) {
      console.log(`    new P4 hits: ${r.p4Only.join("、")}`);
    } else if (r.p4Only.length > 30) {
      console.log(`    new P4 hits (top 30): ${r.p4Only.slice(0, 30).join("、")}`);
    }
  }

  // 16-成语 coverage check
  console.log(`\n=== 16 PSLE-tested 成语 coverage ===`);
  const inBefore = PSLE_TESTED_IDIOMS_16.filter(i => beforeSet.has(i));
  const inAfter = PSLE_TESTED_IDIOMS_16.filter(i => afterSet.has(i));
  const beforeIdx = new Set(inBefore);
  const newlyCovered = inAfter.filter(i => !beforeIdx.has(i));
  console.log(`  Before (P5+P6): ${inBefore.length}/16 — ${inBefore.join("、")}`);
  console.log(`  After  (P4+P5+P6): ${inAfter.length}/16 — ${inAfter.join("、")}`);
  console.log(`  Newly covered by P4: ${newlyCovered.length} — ${newlyCovered.join("、") || "(none)"}`);
  const stillMissing = PSLE_TESTED_IDIOMS_16.filter(i => !inAfter.includes(i));
  console.log(`  Still missing: ${stillMissing.length} — ${stillMissing.join("、") || "(none)"}`);

  // Write a structured report
  const md: string[] = [];
  md.push("# P4 wordlist coverage impact\n");
  md.push(`Comparing PSLE coverage before vs after adding P4 wordlist.\n`);
  md.push(`**Wordlist size:**`);
  md.push(`- P4 alone: ${p4.size} words`);
  md.push(`- P5 alone: ${p5.size} words`);
  md.push(`- P6 alone: ${p6.size} words`);
  md.push(`- Before (P5+P6, dedup): **${beforeSet.size}** words`);
  md.push(`- After (P4+P5+P6, dedup): **${afterSet.size}** words`);
  md.push(`- P4-only additions: ${p4OnlyAdditions.length} words\n`);

  md.push(`## PSLE section coverage delta\n`);
  md.push(`| Section | Before | After | Δ |`);
  md.push(`|---------|--------|-------|---|`);
  for (const r of rows) {
    md.push(`| ${r.section} | ${r.before} | ${r.after} | **+${r.delta}** |`);
  }

  md.push(`\n## 16 PSLE-tested 成语 coverage\n`);
  md.push(`| Idiom | Before (P5+P6) | After (P4+P5+P6) |`);
  md.push(`|-------|----------------|------------------|`);
  for (const i of PSLE_TESTED_IDIOMS_16) {
    const b = beforeSet.has(i) ? "✓" : "—";
    const a = afterSet.has(i) ? "✓" : "—";
    const tag = !beforeSet.has(i) && afterSet.has(i) ? " **NEW**" : "";
    md.push(`| ${i} | ${b} | ${a}${tag} |`);
  }
  md.push(`\n**Coverage:** ${inAfter.length}/16 = ${Math.round(100 * inAfter.length / 16)}% (was ${Math.round(100 * inBefore.length / 16)}%)`);
  if (stillMissing.length > 0) {
    md.push(`\n**Still missing**: ${stillMissing.join("、")} — likely P3 or earlier.`);
  }

  // Per-section new hits detail
  md.push(`\n## New P4 hits per section\n`);
  for (const r of rows) {
    if (r.p4Only.length === 0) continue;
    md.push(`\n### ${r.section} (+${r.p4Only.length})`);
    md.push(r.p4Only.join("、"));
  }

  const outPath = path.join(__dirname, "..", "..", "documents", "P4 wordlist coverage impact.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`\nWrote ${outPath}`);

  await prisma.$disconnect();
})();
