// Re-classify every PSLE Math question (2016-2025) with a SINGLE
// consistent taxonomy + trap-pattern tagger, so trends are
// apples-to-apples. The Prisma syllabusTopic field is inconsistent
// across years (2025 tags place-value / unit-conversion / patterns
// as "Algebra"; earlier years don't), so we don't trust it.
//
// Output: psle-math-classified.json with { topic, traps[] } per
// question, plus a console-printed by-marks distribution and trap
// frequency table.

import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";

type Q = {
  questionNum: string;
  marksAvailable: number | null;
  syllabusTopic: string | null;
  subTopic: string | null;
  transcribedStem: string | null;
  transcribedOptions?: unknown;
  answer?: string | null;
};
type Paper = { year: string; title: string; questions: Q[] };

const TOPICS = [
  "Whole Numbers",          // place value, four ops, factors, multiples, ordering, missing-number
  "Fractions",
  "Decimals",
  "Percentage",
  "Ratio",
  "Algebra",                // ONLY genuine variable/expression/substitution
  "Speed",
  "Measurement",            // length / mass / time / money / volume of liquid / unit conversion
  "Geometry",               // angles, parallel lines, triangles, quadrilaterals, polygons
  "Area & Perimeter",       // includes circle area/circumference
  "Volume of Cuboid",       // includes water-in-tank
  "Statistics",             // pie/bar/line charts, table reading, average
  "Number Patterns",        // sequence/pattern questions
] as const;

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

type Classification = {
  questionNum: string;
  topic: typeof TOPICS[number];
  traps: typeof TRAP_PATTERNS[number][];
};

function buildPrompt(year: string, questions: Q[]): string {
  const items = questions.map(q => {
    const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 600);
    return `Q${q.questionNum} (${q.marksAvailable ?? "?"}m): ${stem}`;
  }).join("\n\n");
  return `You are classifying PSLE Mathematics questions from the ${year} paper.

For each question, return:
1. ONE topic from this fixed list (use exactly the spelling shown):
${TOPICS.map(t => `   - ${t}`).join("\n")}

   Critical disambiguations:
   - "Algebra" ONLY for questions involving a variable/letter (n, x, y, p, k, etc.) in an expression, equation, or substitution. NOT for missing-number place value like "1045 = □ + 40 + 5" — that is Whole Numbers.
   - "Whole Numbers" covers: place value, factor/multiple, ordering whole numbers, missing-number arithmetic, four operations.
   - "Decimals" covers: ordering decimals, decimal place value, decimal arithmetic.
   - "Measurement" covers: time intervals (e.g., "from 10.55am to 12.45pm"), unit conversions (3050m = ?km), money totals, mass, length, volume of liquid. NOT volume of cuboid.
   - "Number Patterns" for sequence-finding questions ("find next two numbers that appear in both patterns").
   - If a question spans two areas (e.g., ratio of percentages), pick the DOMINANT skill being tested.

2. ZERO OR MORE trap patterns from this fixed list (empty array if none apply):
${TRAP_PATTERNS.map(t => `   - ${t}`).join("\n")}

   Definitions:
   - before_after_ratio_change: ratio of two quantities changes after some addition/subtraction (very common).
   - remaining_of_remaining_fraction: take fraction of original, then fraction of what's LEFT (multi-step).
   - unit_conversion_mid_problem: student must convert units (km↔m, L↔ml, h↔min) as part of solving — trap if a wrong-unit answer is plausible.
   - equalisation_or_equal_remainder: "both ended up with same amount" / "equal amount left over".
   - pattern_sequence_finding: identify the nth term or next term in a sequence/pattern.
   - folded_paper_geometry: a shape is folded so corners/edges meet; solve for angles or lengths.
   - painted_cube_surface_area: cube painted on outside, cut into smaller cubes, count painted faces.
   - multi_stage_speed_or_meeting: two objects moving / meeting / overtaking, often with stages or different speeds.
   - combined_figure_area_subtraction: area of complex figure = big shape minus small shape (or sum of parts).
   - hidden_equal_quantity_assumption: solution requires noticing two unstated quantities must be equal.

Return JSON ONLY (no prose, no fences):
{ "classifications": [ { "questionNum": "1", "topic": "Whole Numbers", "traps": [] }, ... ] }

Questions to classify:

${items}`;
}

async function classifyPaper(ai: GoogleGenAI, paper: Paper): Promise<Classification[]> {
  const prompt = buildPrompt(paper.year, paper.questions);
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { temperature: 0, responseMimeType: "application/json" },
  });
  const text = res.text ?? "";
  const parsed = JSON.parse(text) as { classifications: Classification[] };
  return parsed.classifications;
}

async function main() {
  const dumpPath = path.join(__dirname, "psle-math-dump.json");
  const raw = await fs.readFile(dumpPath, "utf8");
  const papers: Paper[] = JSON.parse(raw);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 180000 } });

  const enriched: Array<Paper & { classifications: Classification[] }> = [];
  for (const p of papers) {
    process.stdout.write(`Classifying ${p.year} (${p.questions.length} qs)... `);
    try {
      const classifications = await classifyPaper(ai, p);
      enriched.push({ ...p, classifications });
      console.log(`done (${classifications.length})`);
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`);
      enriched.push({ ...p, classifications: [] });
    }
  }

  const outPath = path.join(__dirname, "psle-math-classified.json");
  await fs.writeFile(outPath, JSON.stringify(enriched, null, 2));
  console.log(`\nWrote ${outPath}`);

  // === Tabulate by marks ===
  console.log("\n=== Topic distribution by MARKS per year ===");
  const allTopics = [...TOPICS];
  const header = ["topic", ...enriched.map(p => p.year)].join("\t");
  console.log(header);
  for (const topic of allTopics) {
    const row: string[] = [topic];
    for (const p of enriched) {
      const classByNum = new Map(p.classifications.map(c => [c.questionNum, c]));
      let marks = 0;
      for (const q of p.questions) {
        const c = classByNum.get(q.questionNum);
        if (c?.topic === topic) marks += q.marksAvailable ?? 0;
      }
      row.push(String(marks));
    }
    console.log(row.join("\t"));
  }

  // Total marks per year (sanity check).
  const totalRow = ["TOTAL"];
  for (const p of enriched) {
    const total = p.questions.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    totalRow.push(String(total));
  }
  console.log(totalRow.join("\t"));

  // === Trap pattern marks by year ===
  console.log("\n=== Trap pattern MARKS per year ===");
  const trapHeader = ["trap", ...enriched.map(p => p.year)].join("\t");
  console.log(trapHeader);
  for (const trap of TRAP_PATTERNS) {
    const row: string[] = [trap];
    for (const p of enriched) {
      const classByNum = new Map(p.classifications.map(c => [c.questionNum, c]));
      let marks = 0;
      for (const q of p.questions) {
        const c = classByNum.get(q.questionNum);
        if (c?.traps?.includes(trap)) marks += q.marksAvailable ?? 0;
      }
      row.push(String(marks));
    }
    console.log(row.join("\t"));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
