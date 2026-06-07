// Any marked paper with subject=null gets bucketed as "Other" on the
// progress page even when its question topics make the subject obvious
// (e.g. David Lim's diagnostic — every question is a science topic but
// the diagnostic flow left subject=null when the email-parsed header
// didn't include one). Infer subject from question topics and write
// it back to the paper.

import { prisma } from "../src/lib/db";

// Known topic-name fragments per subject. Matched substring,
// case-insensitive. Order matters — we count hits across all
// questions and assign the subject with the most hits.
const SUBJECT_HINTS: Array<{ subject: string; needles: string[] }> = [
  { subject: "Science", needles: [
    "respirat", "circulatory", "digest", "reproduc", "interaction", "cycle",
    "diversity", "ecosystem", "habitat", "circuit", "magnet", "energy",
    "heat", "light", "sound", "force", "matter", "evaporation", "condensation",
    "photosyn", "respirat", "chlorophyll", "organism", "plant", "animal",
    "human ", "respiratory", "circulatory",
  ]},
  { subject: "Math", needles: [
    "fraction", "ratio", "percent", "decimal", "algebra", "geometry",
    "perimeter", "area", "volume", "angle", "graph", "speed", "time",
    "money", "measurement", "number pattern", "average", "rate",
  ]},
  { subject: "English", needles: [
    "grammar", "vocab", "comprehension", "synthesis", "transformation",
    "editing", "cloze", "visual text",
  ]},
  { subject: "Chinese", needles: [
    "华文", "中文", "汉字", "成语", "病句", "造句", "完成对话",
    "阅读理解", "短文填空", "字音", "字形", "词语",
  ]},
];

function inferSubject(topics: (string | null)[]): string | null {
  const tagged = topics.filter((t): t is string => !!t && t.trim() !== "");
  if (tagged.length === 0) return null;
  const lower = tagged.map(t => t.toLowerCase());
  const scores = new Map<string, number>();
  for (const { subject, needles } of SUBJECT_HINTS) {
    let hits = 0;
    for (const t of lower) for (const n of needles) if (t.includes(n.toLowerCase())) { hits++; break; }
    scores.set(subject, hits);
  }
  let bestSubject: string | null = null;
  let bestScore = 0;
  for (const [s, h] of scores) {
    if (h > bestScore) { bestScore = h; bestSubject = s; }
  }
  // Demand ≥50% of tagged questions to back the winning subject so we
  // don't mis-classify on incidental matches.
  if (bestScore / tagged.length < 0.5) return null;
  return bestSubject;
}

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: { subject: null },
    select: {
      id: true, title: true, paperType: true,
      questions: { select: { syllabusTopic: true } },
    },
  });
  console.log(`Found ${papers.length} papers with subject=null`);
  let updated = 0;
  let skipped = 0;
  for (const p of papers) {
    const topics = p.questions.map(q => q.syllabusTopic);
    const inferred = inferSubject(topics);
    if (!inferred) { skipped++; continue; }
    await prisma.examPaper.update({ where: { id: p.id }, data: { subject: inferred } });
    console.log(`  ${p.id} type=${p.paperType ?? "(master)"} → subject="${inferred}" title="${p.title.slice(0, 50)}"`);
    updated++;
  }
  console.log(`Updated ${updated} papers; skipped ${skipped} (insufficient topic signal).`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
