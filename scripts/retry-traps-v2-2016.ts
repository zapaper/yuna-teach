// Retry v2 strict tagging for just the 2016 paper, which 504'd on
// the original batch run. Merges the result back into
// psle-math-classified-v2.json in place.

import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = { questionNum: string; marksAvailable: number | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const TRAP_PATTERNS = [
  "before_after_ratio_change", "remaining_of_remaining_fraction",
  "unit_conversion_mid_problem", "equalisation_or_equal_remainder",
  "pattern_sequence_finding", "folded_paper_geometry",
  "painted_cube_surface_area", "multi_stage_speed_or_meeting",
  "combined_figure_area_subtraction", "hidden_equal_quantity_assumption",
];

// Same strict prompt as v2.
function buildPrompt(year: string, questions: Q[]): string {
  const items = questions.map(q => `Q${q.questionNum} (${q.marksAvailable ?? "?"}m): ${(q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 700)}`).join("\n\n");
  return `Audit PSLE Math ${year} for SPECIFIC trap patterns. Be conservative — when in doubt, return empty array. Most questions have ZERO traps.

Strict definitions (only tag if question CLEARLY fits):

1. before_after_ratio_change: REQUIRES ratio/fraction stated at "first" + ACTION (transfer/add/remove) + NEW ratio stated after. NOT for transfer-only problems.
2. remaining_of_remaining_fraction: REQUIRES fraction of REMAINDER after previous fraction taken. Nested, not parallel.
3. unit_conversion_mid_problem: REQUIRES km↔m, L↔ml, kg↔g, $↔cents, h↔min, m↔cm conversion mid-solving. Dollar arithmetic alone does NOT count.
4. equalisation_or_equal_remainder: REQUIRES two parties ending with SAME amount, or equal remainders after transfers.
5. pattern_sequence_finding: REQUIRES identifying nth term / predicting later figure/term in sequence.
6. folded_paper_geometry: REQUIRES shape FOLDED so edges/corners meet. Cutting doesn't count.
7. painted_cube_surface_area: REQUIRES 3D solid painted outside, cut into smaller cubes, count painted faces.
8. multi_stage_speed_or_meeting: REQUIRES ≥2 moving objects OR one object with 2+ speeds/stages.
9. combined_figure_area_subtraction: REQUIRES composite figure of 2+ standard shapes OR shaded = big − small.
10. hidden_equal_quantity_assumption: REQUIRES explicit equal-quantity constraint that's the KEY unlock. Ratio simultaneous-equations alone do NOT count.

Rules: most questions = zero traps. Never tag 3+ per question. Conservative.

Return JSON: { "classifications": [{ "questionNum": "1", "traps": [] }, ...] }

Questions:

${items}`;
}

async function main() {
  const outPath = path.join(__dirname, "psle-math-classified-v2.json");
  const raw = await fs.readFile(outPath, "utf8");
  const papers: Paper[] = JSON.parse(raw);
  const p2016 = papers.find(p => p.year === "2016");
  if (!p2016) throw new Error("2016 paper not found");

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 240000 } });

  // Three retries on transient timeouts.
  let parsed: { classifications: Array<{ questionNum: string; traps: string[] }> } | null = null;
  for (let attempt = 1; attempt <= 3 && !parsed; attempt++) {
    try {
      process.stdout.write(`Retry attempt ${attempt} for 2016... `);
      const res = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: buildPrompt("2016", p2016.questions) }] }],
        config: { temperature: 0, responseMimeType: "application/json" },
      });
      parsed = JSON.parse(res.text ?? "") as typeof parsed;
      console.log(`done (${parsed!.classifications.length} classifications)`);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message.slice(0, 200)}`);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  const newTraps = new Map(parsed!.classifications.map(c => [c.questionNum.replace(/^Q/, ""), c.traps]));
  for (const c of p2016.classifications) {
    const key = c.questionNum.replace(/^Q/, "");
    c.traps = newTraps.get(key) ?? [];
  }
  await fs.writeFile(outPath, JSON.stringify(papers, null, 2));
  console.log(`Merged into ${outPath}`);

  // Re-tabulate overall trap marks.
  const norm = (s: string) => s.replace(/^Q/, "");
  console.log("\n=== OVERALL trap marks per year (v2 strict, with 2016 fixed) ===\n");
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
}

main().catch(e => { console.error(e); process.exit(1); });
