// Probe: how many Math PSLE + P6 prelim questions match each
// hidden-constant-total category by stem keywords? Read-only — counts
// + samples, no DB writes. Use this to validate the regex per category
// before wiring it into a real classifier.
//
// Categories (mirrors math-hidden-constant-total.yaml sub-topics):
//   A. internal-transfer   — give-and-take, total constant
//   B. equal-removal       — same change to both, gap constant
//   C. one-constant        — only one side changed
//   D. equalise-ratios     — same total, different before/after ratios
//   E. weight-difference   — equal counts, different mixes (coins/notes/items)

import { prisma } from "../src/lib/db";

type Cat = "A-transfer" | "B-equal-removal" | "C-one-constant" | "D-equalise-ratios" | "E-weight-difference";

const CATEGORIES: Array<{ id: Cat; regex: RegExp; desc: string }> = [
  {
    id: "A-transfer",
    desc: "Internal transfer (give-and-take)",
    regex: new RegExp([
      "\\b(gave|gives|hand(?:ed)?|pass(?:ed)?|transfer(?:red)?)\\b.*\\bto\\b",
      "\\b(gave|gives)\\b.*\\b(some|half|part)\\b",
      "give-?and-?take",
      "\\bafter\\b.*\\bratio\\b.*\\bchanged\\b",
    ].join("|"), "i"),
  },
  {
    id: "B-equal-removal",
    desc: "Equal change to both parts (gap stays the same)",
    regex: new RegExp([
      "\\beach\\b.*\\b(spent|used|gave away|drank|ate|added|saved|removed|donated|lost)\\b",
      "\\bboth\\b.*\\b(spent|used|added|received|gained|removed)\\b.*\\bsame\\b",
      "same\\s+amount\\s+(?:of|was)\\s+(spent|used|removed|added|donated)",
      "\\bthe same number of\\b.*\\b(was|were)\\b\\s+(removed|added|taken)",
    ].join("|"), "i"),
  },
  {
    id: "C-one-constant",
    desc: "Only one side changed; other side is the anchor",
    regex: new RegExp([
      "\\b(only|just)\\b.*\\b(spent|used|gave|lost|received|added)\\b",
      "\\bwhile\\b.*\\b(remained|stayed|unchanged|did not)\\b",
      "\\bdid not change\\b",
      "\\b(unchanged|untouched)\\b",
      "\\bstill had\\b",
    ].join("|"), "i"),
  },
  {
    id: "D-equalise-ratios",
    desc: "Equal total, different before/after ratios",
    regex: new RegExp([
      "\\bratio\\b.*\\bchanged\\b",
      "\\bbefore\\b.*\\bratio\\b.*\\bafter\\b.*\\bratio\\b",
      "\\bnew\\s+ratio\\b",
      "\\bbecame\\b\\s+\\d+\\s*:\\s*\\d+",
      "\\bratio\\b.*\\b\\d+\\s*:\\s*\\d+\\b.*\\bratio\\b.*\\b\\d+\\s*:\\s*\\d+\\b",
    ].join("|"), "i"),
  },
  {
    id: "E-weight-difference",
    desc: "Equal counts, different mixes (coins / notes / stamps / items of different values)",
    regex: new RegExp([
      "\\b(coins?|notes?|stamps?|tickets?)\\s+(?:of|worth)\\b",
      "\\b\\d+\\s*-?\\s*cent\\s+(?:and|or)\\b.*\\b\\d+\\s*-?\\s*cent\\b",
      "\\$\\s*\\d+\\s+(?:notes?|coins?)\\b.*\\$\\s*\\d+\\s+(?:notes?|coins?)\\b",
      "\\bsame\\s+(?:number|total)\\s+of\\s+(?:coins?|notes?|stamps?|items?|tickets?)\\b",
    ].join("|"), "i"),
  },
];

function isMcq(q: {
  transcribedOptions: unknown;
  transcribedOptionImages: unknown;
  transcribedOptionTable: unknown;
}): boolean {
  if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) return true;
  if (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(o => !!o)) return true;
  const t = q.transcribedOptionTable;
  if (t && typeof t === "object" && Array.isArray((t as { rows?: unknown }).rows) && (t as { rows: unknown[] }).rows.length === 4) return true;
  return false;
}

async function main() {
  // Math PSLE + P6 prelim papers. Excludes worksheets, synthetic bank,
  // and cloned papers.
  const qs = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "math", mode: "insensitive" },
        OR: [
          { level: { equals: "PSLE", mode: "insensitive" } },
          { level: { in: ["P6", "Primary 6", "6"] } },
          { title: { contains: "PSLE", mode: "insensitive" } },
        ],
      },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedOptionTable: true,
      examPaper: { select: { title: true, year: true } },
    },
  });
  console.log(`Math PSLE + P6 questions scanned: ${qs.length}`);

  type Bucket = { mcq: typeof qs; oeq: typeof qs };
  const buckets = new Map<Cat, Bucket>();
  for (const c of CATEGORIES) buckets.set(c.id, { mcq: [], oeq: [] });
  let unmatched = 0;
  let multiMatch = 0;
  for (const q of qs) {
    const stem = (q.transcribedStem ?? "").trim();
    if (!stem) continue;
    const hits = CATEGORIES.filter(c => c.regex.test(stem));
    if (hits.length === 0) { unmatched++; continue; }
    if (hits.length > 1) multiMatch++;
    // Single-match: definitive bucket.
    // Multi-match: place in FIRST matching category (priority A > B > C > D > E).
    const cat = hits[0].id;
    const b = buckets.get(cat)!;
    if (isMcq(q)) b.mcq.push(q); else b.oeq.push(q);
  }

  console.log(`\nUnmatched: ${unmatched}   Multi-match (took first): ${multiMatch}`);
  console.log(`\n========== PER-CATEGORY COUNTS ==========`);
  for (const c of CATEGORIES) {
    const b = buckets.get(c.id)!;
    console.log(`\n${c.id} — ${c.desc}`);
    console.log(`  MCQ: ${b.mcq.length}   OEQ: ${b.oeq.length}`);
    const samples = [...b.oeq.slice(0, 2), ...b.mcq.slice(0, 1)];
    for (const s of samples) {
      const tag = isMcq(s) ? "[MCQ]" : "[OEQ]";
      const paperTag = `${s.examPaper.title}${s.examPaper.year ? ` (${s.examPaper.year})` : ""}`;
      console.log(`  ${tag} ${paperTag} Q${s.questionNum}: ${(s.transcribedStem ?? "").trim().replace(/\s+/g, " ").slice(0, 180)}…`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
