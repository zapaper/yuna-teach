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

type Cat = "A-transfer" | "B-equal-removal" | "C-one-constant" | "D-equalise-ratios";

// Pattern E (weight-difference mix) was dropped from the master class
// taxonomy — PSLE only tests it ~once a decade. See commit 8383f693.

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
  console.log(`\n========== FULL LISTING (for manual cleanup) ==========`);
  console.log(`Tell me which numbered items to DROP (false positives).`);
  console.log(`Anything not dropped will be tagged with the listed subTopic.`);
  for (const c of CATEGORIES) {
    const b = buckets.get(c.id)!;
    const all = [...b.oeq, ...b.mcq];
    console.log(`\n----------\n${c.id} — ${c.desc}`);
    console.log(`  Total: ${all.length}  (OEQ: ${b.oeq.length}, MCQ: ${b.mcq.length})`);
    all.forEach((q, i) => {
      const tag = isMcq(q) ? "[MCQ]" : "[OEQ]";
      const paperTag = `${q.examPaper.title}${q.examPaper.year ? ` ${q.examPaper.year}` : ""}`;
      const stem = (q.transcribedStem ?? "").trim().replace(/\s+/g, " ");
      const num = `${c.id.charAt(0)}.${(i + 1).toString().padStart(2, "0")}`;
      console.log(`  ${num} ${tag} ${paperTag} Q${q.questionNum} (id=${q.id.slice(0, 10)})`);
      console.log(`        ${stem.slice(0, 260)}${stem.length > 260 ? "…" : ""}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
