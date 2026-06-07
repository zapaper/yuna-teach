// Survey of "pattern" questions in the bank, ahead of designing a
// Master Class on patterns. Patterns aren't a syllabus topic of their
// own — they hide under Algebra / Basic math operations / Statistics.
// We detect them by keyword in the stem and group by sub-flavor.

import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

type Row = {
  id: string;
  questionNum: string;
  marksAvailable: number | null;
  syllabusTopic: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  answer: string | null;
  studentAnswer: string | null;
  elaboration: string | null;
  markingNotes: string | null;
  examPaper: { title: string; subject: string | null; level: string | null };
};

const PATTERN_RX = /\b(pattern|sequence|figure (\d+|n|number)|next term|next number|missing number|nth term|the (\d+)(st|nd|rd|th) (figure|term|number|row|step)|continues|each figure|figure[s]? show)\b/i;

function brief(s: string | null | undefined, n = 600): string {
  if (!s) return "";
  return s.trim().replace(/\s+/g, " ").slice(0, n);
}

(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      examPaper: { subject: { contains: "Math", mode: "insensitive" } },
    },
    select: {
      id: true, questionNum: true, marksAvailable: true,
      syllabusTopic: true,
      transcribedStem: true, transcribedOptions: true,
      answer: true, studentAnswer: true,
      elaboration: true, markingNotes: true,
      examPaper: { select: { title: true, subject: true, level: true } },
    },
    take: 12000,
  });

  // Dedupe by stem prefix — bank has lots of repeated test-quiz questions
  const seenStem = new Set<string>();
  const hits: Row[] = [];
  for (const q of rows) {
    if (!q.transcribedStem) continue;
    if (!PATTERN_RX.test(q.transcribedStem)) continue;
    const key = q.transcribedStem.slice(0, 120).toLowerCase();
    if (seenStem.has(key)) continue;
    seenStem.add(key);
    hits.push(q as Row);
  }

  console.log(`Total pattern questions (deduped): ${hits.length}\n`);

  // By syllabus topic
  const byTopic = new Map<string, number>();
  for (const h of hits) {
    const t = h.syllabusTopic ?? "(untagged)";
    byTopic.set(t, (byTopic.get(t) ?? 0) + 1);
  }
  console.log("By syllabus topic:");
  for (const [t, n] of [...byTopic.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${t}`);
  }

  // By exam paper type
  function paperKind(title: string): string {
    if (/prelim/i.test(title)) return "Prelim";
    if (/PSLE/i.test(title)) return "PSLE";
    if (/WA\s*\d|EOY|End of Year/i.test(title)) return "WA/EOY";
    if (/Daily Quiz/i.test(title)) return "Daily Quiz";
    if (/Focused/i.test(title)) return "Focused";
    if (/MCQ\+|OEQ|Quiz/i.test(title)) return "Other Quiz";
    return "Other";
  }
  const byKind = new Map<string, number>();
  for (const h of hits) {
    const k = paperKind(h.examPaper.title);
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  console.log("\nBy paper kind:");
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${k}`);
  }

  // By level (P3-P6)
  const byLevel = new Map<string, number>();
  for (const h of hits) {
    const lvl = (h.examPaper.level ?? "(unknown)").replace(/Primary\s*/i, "P");
    byLevel.set(lvl, (byLevel.get(lvl) ?? 0) + 1);
  }
  console.log("\nBy level:");
  for (const [l, n] of [...byLevel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${l}`);
  }

  // FLAVORS of pattern questions — keyword-based sub-classification
  function flavor(stem: string): string[] {
    const s = stem.toLowerCase();
    const out: string[] = [];
    if (/figure \d|next figure|each figure|figures? \d/.test(s)) out.push("Figure-based pattern");
    if (/tiles?|dots?|circles?|squares?|sticks?|beads?|coins?/.test(s)) out.push("Counts-of-objects");
    if (/sequence of numbers|number pattern|missing number|next number|pattern below|the pattern/.test(s)) out.push("Number sequence");
    if (/triangular|square number|cube number/.test(s)) out.push("Figurate numbers");
    if (/grey|white|black|alternating|alternate/.test(s)) out.push("Alternating colors");
    if (/nth term|the (\d+)(st|nd|rd|th)/.test(s)) out.push("Find the nth term");
    if (/total|altogether|sum/.test(s)) out.push("Total/sum across pattern");
    if (/odd|even/.test(s)) out.push("Odd/even rule");
    if (out.length === 0) out.push("Other");
    return out;
  }
  const flavorCount = new Map<string, number>();
  for (const h of hits) {
    for (const f of flavor(h.transcribedStem!)) {
      flavorCount.set(f, (flavorCount.get(f) ?? 0) + 1);
    }
  }
  console.log("\nBy flavor (questions can be multi-tagged):");
  for (const [f, n] of [...flavorCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${f}`);
  }

  // PSLE-only count for the headline stat
  const psleOnly = hits.filter(h => /PSLE/i.test(h.examPaper.title));
  console.log(`\nPSLE pattern questions specifically: ${psleOnly.length}`);
  const psleMarks = psleOnly.reduce((sum, q) => sum + (q.marksAvailable ?? 0), 0);
  const psleOEQ = psleOnly.filter(q => !Array.isArray(q.transcribedOptions) || (q.transcribedOptions as unknown[]).length !== 4).length;
  console.log(`PSLE pattern marks total: ${psleMarks}`);
  console.log(`PSLE pattern OEQ: ${psleOEQ}, MCQ: ${psleOnly.length - psleOEQ}`);

  // Dump full set for manual review when designing slides
  const dump = hits.map(h => ({
    id: h.id, paper: h.examPaper.title, level: h.examPaper.level,
    topic: h.syllabusTopic, marks: h.marksAvailable,
    mcq: Array.isArray(h.transcribedOptions) && (h.transcribedOptions as unknown[]).length === 4,
    stem: brief(h.transcribedStem, 500),
    options: Array.isArray(h.transcribedOptions) ? (h.transcribedOptions as string[]).map((o, i) => `(${i+1}) ${o}`).join("  ") : "",
    correct: brief(h.answer, 400),
    student: brief(h.studentAnswer, 200),
    elaboration: brief(h.elaboration, 1500),
    markingNotes: brief(h.markingNotes, 600),
    flavor: flavor(h.transcribedStem!).join(" | "),
  }));
  const file = path.join(process.cwd(), "scripts", "pattern-questions-dump.json");
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`\nDump: ${file}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
