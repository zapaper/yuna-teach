// Sweep paper for cases where markingNotes shows "Awarded N mark(s)"
// lines summing to a different number than marksAwarded. This is
// THE smoking gun for tabulation falling through.
import { prisma } from "../src/lib/db";

const PAPER = "cmq34sx5b004qgnicjxy3flh6";

function parseProseSum(notes: string, marksAvailable: number): { sum: number; partAwards: {label: string; awarded: number}[] } {
  // Reconstruct parsed.notes (strip "Detected: ..." prefix that buildMarkingNotes adds)
  const sepIdx = notes.indexOf(" | ");
  const notesStr = sepIdx >= 0 ? notes.slice(sepIdx + 3) : notes;
  const partRe = /(?:^|[\n|])\s*(?:Part\s*)?\(([a-z])\)\s*:?\s*([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z]\)\s*:?|$)/gi;
  const partAwards: { label: string; awarded: number }[] = [];
  for (const m of notesStr.matchAll(partRe)) {
    const chunk = m[2];
    const awardMatch = chunk.match(/awarded\s+(\d+(?:\.\d+)?)\s*mark(?:s|\(s\))?\b/i);
    if (!awardMatch) continue;
    partAwards.push({ label: m[1].toLowerCase(), awarded: parseFloat(awardMatch[1]) });
  }
  // Single-part fallback: detect any "Awarded N mark(s)" anywhere in the
  // notes for single-part questions.
  if (partAwards.length < 2) {
    const single = notesStr.match(/awarded\s+(\d+(?:\.\d+)?)\s*mark(?:s|\(s\))?\b/i);
    if (single) return { sum: Math.min(marksAvailable, parseFloat(single[1])), partAwards: [{label: "", awarded: parseFloat(single[1])}] };
  }
  const sum = partAwards.reduce((s, p) => s + p.awarded, 0);
  return { sum: Math.min(marksAvailable, sum), partAwards };
}

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    orderBy: { orderIndex: "asc" },
    select: { id: true, questionNum: true, marksAvailable: true, marksAwarded: true, markingNotes: true },
  });
  console.log(`Auditing ${qs.length} questions on ${PAPER}\n`);
  let anyMismatch = false;
  for (const q of qs) {
    if (!q.markingNotes) continue;
    const { sum, partAwards } = parseProseSum(q.markingNotes, q.marksAvailable ?? 1);
    const stored = q.marksAwarded ?? 0;
    if (partAwards.length === 0) {
      console.log(`Q${q.questionNum}  stored=${stored}/${q.marksAvailable}  notes: no 'Awarded' lines (likely MCQ or special)`);
      continue;
    }
    const mismatch = Math.abs(stored - sum) > 0.0001;
    const flag = mismatch ? " ❌ MISMATCH" : " ✓";
    console.log(`Q${q.questionNum}  stored=${stored}/${q.marksAvailable}  prose-sum=${sum}  parts=[${partAwards.map(p => `${p.label}=${p.awarded}`).join(", ")}]${flag}`);
    if (mismatch) anyMismatch = true;
  }
  console.log(`\nResult: ${anyMismatch ? "MISMATCHES FOUND — tabulation broken" : "all good"}`);
  process.exit(0);
}
main();
