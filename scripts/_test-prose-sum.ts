import { prisma } from "../src/lib/db";

async function main() {
  const q = await prisma.examQuestion.findUnique({
    where: { id: "cmq34sx5f0050gnicw2x563yk" },
    select: { markingNotes: true, marksAvailable: true, marksAwarded: true },
  });
  if (!q?.markingNotes) { console.log("no notes"); process.exit(0); }
  const full = q.markingNotes;
  console.log("=== FULL stored markingNotes ===");
  console.log(JSON.stringify(full));

  // Reconstruct what `parsed.notes` would have been:
  // buildMarkingNotes builds "Detected: <student> | <notes>"
  // Split on the FIRST " | " — that's the AI's notes side.
  const sepIdx = full.indexOf(" | ");
  const notesStr = sepIdx >= 0 ? full.slice(sepIdx + 3) : full;
  console.log("\n=== Reconstructed parsed.notes (after stripping 'Detected:' prefix) ===");
  console.log(JSON.stringify(notesStr));

  // Run the prose-sum regex from src/lib/marking.ts ~line 5380
  const partRe = /(?:^|[\n|])\s*(?:Part\s*)?\(([a-z])\)\s*:?\s*([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z]\)\s*:?|$)/gi;
  const partAwards: { label: string; awarded: number; chunk: string }[] = [];
  for (const m of notesStr.matchAll(partRe)) {
    const label = m[1].toLowerCase();
    const chunk = m[2];
    const awardMatch = chunk.match(/awarded\s+(\d+(?:\.\d+)?)\s*mark(?:s|\(s\))?\b/i);
    if (!awardMatch) {
      console.log(`\n  matched (${label}) but no 'Awarded N' — skipping. chunk: ${JSON.stringify(chunk.slice(0, 100))}`);
      continue;
    }
    partAwards.push({ label, awarded: parseFloat(awardMatch[1]), chunk: chunk.slice(0, 80) });
  }
  console.log("\n=== partAwards ===");
  console.log(JSON.stringify(partAwards, null, 2));
  console.log(`\nsum = ${partAwards.reduce((s, p) => s + p.awarded, 0)}`);
  console.log(`DB marksAwarded = ${q.marksAwarded}, marksAvailable = ${q.marksAvailable}`);

  process.exit(0);
}
main();
