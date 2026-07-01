// How many MCQ-eligible master questions do we have per (level, subject,
// topic, subTopic)? Answers the "sufficient variety" question for the
// proposed 20-min onboarding diagnostic:
//   - English: 3 per grammar rule + 2 per synthesis trick
//   - Math / Science: 3 per top-N topic per level (P4-P6)
//
// Filter: master questions only (paperType null, no sourceExamId,
// extractionStatus=ready), from PDF-extracted level-tagged papers.

import "dotenv/config";
import { prisma } from "../src/lib/db";

const GRAMMAR_SUBTOPICS = [
  "connectors-tenses",
  "verb-forms",
  "idiomatic-prepositions",
  "tag-questions",
  "countable/uncountable",
  "subject-verb-agreement",
  "pronouns",
];
const SYNTH_SUBTOPICS = [
  "reported-speech",
  "correlative-preference",
  "subordinator",
  "participle-clauses",
  "substitution-inversion",
  "noun-phrase",
];

(async () => {
  // ── ENGLISH: grammar + synthesis coverage by sub-topic ×  level ──
  console.log(`===== ENGLISH (Grammar + Synthesis) =====`);
  for (const level of ["Primary 4", "Primary 5", "Primary 6", "PSLE"] as const) {
    console.log(`\n── ${level} English ──`);
    const rows = await prisma.examQuestion.findMany({
      where: {
        examPaper: {
          sourceExamId: null, paperType: null, extractionStatus: "ready",
          subject: { contains: "english", mode: "insensitive" },
        },
        // MCQ-eligible = has transcribedOptions
        // MCQ filter is applied in JS below (Prisma JSON filters
        // don't play nicely with array-length semantics).
      },
      select: {
        subTopic: true, syllabusTopic: true, transcribedOptions: true,
        examPaper: { select: { level: true } },
      },
    });
    const filtered = rows.filter(r => r.examPaper.level === level && Array.isArray(r.transcribedOptions) && r.transcribedOptions.length > 0);
    const isGrammar = (t: string | null) => t === "Grammar MCQ" || t === "Grammar Cloze";
    const isSynth = (t: string | null) => (t ?? "").toLowerCase().startsWith("synthesis");
    const gramBySub = new Map<string, number>();
    const synthBySub = new Map<string, number>();
    for (const r of filtered) {
      if (isGrammar(r.syllabusTopic)) {
        const k = r.subTopic ?? "(untagged)";
        gramBySub.set(k, (gramBySub.get(k) ?? 0) + 1);
      } else if (isSynth(r.syllabusTopic)) {
        const k = r.subTopic ?? "(untagged)";
        synthBySub.set(k, (synthBySub.get(k) ?? 0) + 1);
      }
    }
    console.log(`  Grammar MCQ (target 3/rule):`);
    for (const s of GRAMMAR_SUBTOPICS) {
      const n = gramBySub.get(s) ?? 0;
      const flag = n < 3 ? " ⚠" : "";
      console.log(`    ${s.padEnd(30)}  ${n.toString().padStart(3)}${flag}`);
    }
    if (gramBySub.get("(untagged)")) console.log(`    (untagged)                      ${gramBySub.get("(untagged)")}`);
    console.log(`  Synthesis (MCQ; target 2/trick):`);
    for (const s of SYNTH_SUBTOPICS) {
      const n = synthBySub.get(s) ?? 0;
      const flag = n < 2 ? " ⚠" : "";
      console.log(`    ${s.padEnd(30)}  ${n.toString().padStart(3)}${flag}`);
    }
    if (synthBySub.get("(untagged)")) console.log(`    (untagged)                      ${synthBySub.get("(untagged)")}`);
  }

  // ── MATH & SCIENCE: MCQ coverage by syllabus topic × level ──
  for (const subj of ["Math", "Science"] as const) {
    console.log(`\n===== ${subj.toUpperCase()} =====`);
    const rows = await prisma.examQuestion.findMany({
      where: {
        examPaper: {
          sourceExamId: null, paperType: null, extractionStatus: "ready",
          subject: { contains: subj.toLowerCase(), mode: "insensitive" },
        },
        // MCQ filter is applied in JS below (Prisma JSON filters
        // don't play nicely with array-length semantics).
      },
      select: {
        syllabusTopic: true, transcribedOptions: true,
        examPaper: { select: { level: true } },
      },
    });
    for (const level of ["Primary 4", "Primary 5", "Primary 6", "PSLE"] as const) {
      console.log(`\n── ${level} ${subj} MCQ coverage per topic ──`);
      const byTopic = new Map<string, number>();
      for (const r of rows) {
        if (r.examPaper.level !== level) continue;
        if (!Array.isArray(r.transcribedOptions) || r.transcribedOptions.length === 0) continue;
        const t = r.syllabusTopic ?? "(no topic)";
        byTopic.set(t, (byTopic.get(t) ?? 0) + 1);
      }
      const sorted = [...byTopic.entries()].sort((a, b) => b[1] - a[1]);
      for (const [t, n] of sorted) {
        const flag = n < 3 ? " ⚠<3" : "";
        console.log(`    ${t.padEnd(52)}  ${n.toString().padStart(3)}${flag}`);
      }
      console.log(`    ── total topics: ${sorted.length}, topics with ≥3 MCQ: ${sorted.filter(([, n]) => n >= 3).length}`);
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
