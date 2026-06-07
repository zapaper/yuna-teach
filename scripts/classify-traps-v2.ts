// Stricter trap-only re-classifier. v1 over-tagged multi-step word
// problems with 2-3 traps each (e.g., a transfer-with-percentage
// question got "before_after_ratio_change" even though no ratio
// changed). v2 narrows each trap to require specific textual cues
// and provides explicit anti-examples. Topic tagging is reused
// from v1; only the traps[] array is overwritten.

import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = {
  questionNum: string;
  marksAvailable: number | null;
  syllabusTopic: string | null;
  subTopic: string | null;
  transcribedStem: string | null;
};
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const TRAP_PATTERNS = [
  "before_after_ratio_change",
  "remaining_of_remaining_fraction",
  "unit_conversion_mid_problem",
  "equalisation_or_equal_remainder",
  "pattern_sequence_finding",
  "folded_paper_geometry",
  "painted_cube_surface_area",
  "multi_stage_speed_or_meeting",
  "combined_figure_area_subtraction",
  "hidden_equal_quantity_assumption",
] as const;

function buildPrompt(year: string, questions: Q[]): string {
  const items = questions.map(q => {
    const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 700);
    return `Q${q.questionNum} (${q.marksAvailable ?? "?"}m): ${stem}`;
  }).join("\n\n");
  return `You are auditing PSLE Mathematics questions from the ${year} paper for SPECIFIC trap patterns.

Tag each question with ZERO OR MORE traps from this list. **Be conservative — only tag a trap if the question CLEARLY fits the strict definition below. When in doubt, return an empty array.** A multi-step word problem can match zero traps; do not feel obliged to find one.

STRICT TRAP DEFINITIONS:

1. **before_after_ratio_change** — REQUIRES all three:
   (a) A ratio (e.g., 3:2, 1:5) or fraction explicitly stated between two quantities at "first" / "at the start"
   (b) An ACTION transfers items, adds, or removes from one or both quantities
   (c) A NEW ratio (or fraction comparison) is given for the "after" state
   ✓ "Boys:girls was 4:1. After 6 more of each joined, ratio became 7:4." — yes
   ✗ "Tina had 97 magnets, gave away 4, large increased by 50%" — NO (no ratio in either state)
   ✗ "Devi/Eric/Haziq donated fractions of their money" — NO (parallel actions, no before/after ratio)

2. **remaining_of_remaining_fraction** — REQUIRES the problem to take a fraction of the REMAINDER after a previous fraction was taken.
   ✓ "Spent 1/4 of money on book, then 2/5 of the REMAINDER on snacks" — yes
   ✗ "Spent 1/4 on book and 2/5 on snacks" (parallel, not nested) — NO

3. **unit_conversion_mid_problem** — REQUIRES at least one explicit unit-system change inside solving (km↔m, L↔ml, kg↔g, $↔cents, h↔min, m↔cm). Money arithmetic in dollars alone does NOT count.
   ✓ "Wire is 10.2m, cut 3 pieces of 8cm each, answer in metres" — yes
   ✓ "$15 for 20 stickers, cost per sticker in cents" — yes
   ✗ "Exchanged $20 of 5-dollar notes for 2-dollar notes" — NO (same unit)
   ✗ "Shelf packed with 30 large books or 45 small books" — NO (equivalence, not unit conversion)

4. **equalisation_or_equal_remainder** — REQUIRES the problem to state or hinge on TWO parties ending with the SAME amount, or BOTH having equal remainders after transfers.
   ✓ "After giving 3/10 to Sam and 1/4 to Ted, Rudi had equal amounts left over" — yes
   ✗ Generic comparison ratios — NO

5. **pattern_sequence_finding** — REQUIRES identifying an nth term, predicting a later figure/term in a numerical or geometric sequence.
   ✓ "Figure 1, 2, 3 shown — find triangles in Figure 100" — yes
   ✓ "Find next 2 numbers common to both sequences" — yes
   ✗ A static figure with parts that follow a visual pattern but no extrapolation — NO

6. **folded_paper_geometry** — REQUIRES a flat shape (square/rectangle/triangle) being FOLDED so edges or corners meet, then asking for resulting angles/lengths.
   ✓ "Square folded along diagonal so P meets Q" — yes
   ✗ Cutting / rearranging without folding — NO

7. **painted_cube_surface_area** — REQUIRES a 3D solid (usually cube) painted on outside, then cut into smaller cubes, asking about faces painted.
   ✓ "Big cube painted, cut into 1cm cubes, count cubes with 2 painted faces" — yes

8. **multi_stage_speed_or_meeting** — REQUIRES at least TWO moving objects OR one object with TWO speeds/stages in the same problem.
   ✓ "Alice ran 5 km/h then walked 2 km/h" — yes
   ✓ "Jane and Linda jogging, Jane catches up" — yes
   ✗ Single object, single speed — NO

9. **combined_figure_area_subtraction** — REQUIRES finding area/perimeter of a composite figure built from 2+ standard shapes (or shaded region = big minus small).
   ✓ "Find shaded region: rectangle with semicircles removed" — yes
   ✓ "Figure made of 3 quarter circles and 2 straight lines" — yes

10. **hidden_equal_quantity_assumption** — REQUIRES the solving path to depend on an EQUAL QUANTITY constraint that is explicitly stated (e.g., "the two boxes contain the same number") OR clearly implied by symmetry. Must be the KEY unlock for the problem.
    ✓ "Helen and Ivan have the same TOTAL number of coins…" — yes (equal total is key)
    ✓ "Two boxes contained the same number of stars; ratio gold:silver was 1:5 in one and 1:2 in other" — yes
    ✗ Ratio simultaneous-equation problems where no quantity is stated as equal — NO
    ✗ Bar graph with missing scale — NO (that's reading comprehension, not equality)

GLOBAL RULES:
- **Most questions should have ZERO traps.** Single-step calculation, definition recall, or pure formula application = no trap.
- **Never tag the same question with 3+ traps.** If you're tempted to, you're being too liberal.
- **A question can have one trap or zero traps.** Two is allowed only if the question truly chains two separately-recognisable trap patterns.

Return JSON ONLY:
{ "classifications": [ { "questionNum": "1", "traps": [] }, { "questionNum": "P2-15", "traps": ["combined_figure_area_subtraction"] }, ... ] }

Questions to tag:

${items}`;
}

async function reclassifyPaper(ai: GoogleGenAI, paper: Paper): Promise<Map<string, string[]>> {
  const prompt = buildPrompt(paper.year, paper.questions);
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { temperature: 0, responseMimeType: "application/json" },
  });
  const text = res.text ?? "";
  const parsed = JSON.parse(text) as { classifications: Array<{ questionNum: string; traps: string[] }> };
  return new Map(parsed.classifications.map(c => [c.questionNum.replace(/^Q/, ""), c.traps]));
}

async function main() {
  const dumpPath = path.join(__dirname, "psle-math-classified.json");
  const raw = await fs.readFile(dumpPath, "utf8");
  const papers: Paper[] = JSON.parse(raw);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 180000 } });

  // Re-tag traps in place. Topic field is preserved from v1.
  for (const p of papers) {
    process.stdout.write(`Re-tagging ${p.year}... `);
    try {
      const newTraps = await reclassifyPaper(ai, p);
      let touched = 0;
      for (const c of p.classifications) {
        const key = c.questionNum.replace(/^Q/, "");
        const traps = newTraps.get(key);
        if (traps !== undefined) {
          c.traps = traps;
          touched++;
        } else {
          c.traps = []; // missing classification → no traps to be safe
        }
      }
      console.log(`done (${touched}/${p.classifications.length} re-tagged)`);
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`);
    }
  }

  const outPath = path.join(__dirname, "psle-math-classified-v2.json");
  await fs.writeFile(outPath, JSON.stringify(papers, null, 2));
  console.log(`\nWrote ${outPath}`);

  // === Tabulate by marks ===
  const norm = (s: string) => s.replace(/^Q/, "");
  console.log("\n=== OVERALL PAPER trap marks per year (v2 strict) ===\n");
  console.log(["trap", ...papers.map(p => p.year), "AVG"].join("\t"));
  for (const trap of TRAP_PATTERNS) {
    const row: string[] = [trap];
    const yearMarks: number[] = [];
    for (const p of papers) {
      const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
      let marks = 0;
      for (const q of p.questions) {
        const c = classByNum.get(norm(q.questionNum));
        if (c?.traps?.includes(trap)) marks += q.marksAvailable ?? 0;
      }
      yearMarks.push(marks);
      row.push(String(marks));
    }
    const avg = yearMarks.reduce((s, n) => s + n, 0) / yearMarks.length;
    row.push(avg.toFixed(1));
    console.log(row.join("\t"));
  }

  console.log("\n=== PAPER 2 ONLY trap marks per year (v2 strict) ===\n");
  console.log(["trap", ...papers.map(p => p.year), "AVG"].join("\t"));
  for (const trap of TRAP_PATTERNS) {
    const row: string[] = [trap];
    const yearMarks: number[] = [];
    for (const p of papers) {
      const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
      let marks = 0;
      for (const q of p.questions) {
        if (!/^P2-/.test(q.questionNum)) continue;
        const c = classByNum.get(norm(q.questionNum));
        if (c?.traps?.includes(trap)) marks += q.marksAvailable ?? 0;
      }
      yearMarks.push(marks);
      row.push(String(marks));
    }
    const avg = yearMarks.reduce((s, n) => s + n, 0) / yearMarks.length;
    row.push(avg.toFixed(1));
    console.log(row.join("\t"));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
