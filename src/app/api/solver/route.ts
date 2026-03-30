import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { readFileSync } from "fs";
import path from "path";

function getAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
}

function loadTopics(filename: string): string[] {
  try {
    const filePath = path.join(process.cwd(), "data", filename);
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const MATH_TOPICS = loadTopics("math-topics.txt");
const SCIENCE_TOPICS = loadTopics("science-topics.txt");
const ENGLISH_TOPICS = loadTopics("english-topics.txt");

export async function POST(request: NextRequest) {
  const { imageBase64 } = await request.json();
  if (!imageBase64) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }

  const prompt = `You are an expert primary school tutor. Analyse this question image and respond in JSON.

Steps:
1. Identify the subject: "Math", "Science", or "English".
2. Match to ONE topic from the exact list below. You MUST pick a topic from the list word-for-word, or return null if none fits.
   Math topics:
   ${MATH_TOPICS.map((t) => `- "${t}"`).join("\n   ")}
   Science topics:
   ${SCIENCE_TOPICS.map((t) => `- "${t}"`).join("\n   ")}
   English topics:
   ${ENGLISH_TOPICS.map((t) => `- "${t}"`).join("\n   ")}
3. Provide a clear, step-by-step solution suitable for a primary school student.
4. If the question involves ratio, fractions, percentages, or comparing/sharing quantities between people or groups, ALSO return a "diagrams" field — an array of Singapore model method bar diagram steps:
   [
     {
       "title": "<e.g. 'Step 1: Initial ratio' or 'Step 2: After transfer', or null for single-step>",
       "rows": [{ "label": "<name or quantity>", "units": <integer 1-10>, "value": "<known value, '?' if unknown, or null>" }],
       "unitValue": "<value of 1 unit if determinable, else null>"
     }
   ]
   Rules for diagrams:
   - Use MULTIPLE steps when the problem changes state (e.g. quantities transferred, ratios change across two stages) — show each state as its own diagram with a clear title.
   - For straightforward single-state problems, use one entry with title: null.
   - Each row = one person/quantity being compared.
   - "units" = the ratio or fraction number (e.g. ratio 3:5 → units 3 and 5).
   - "value" = the actual quantity if known/solved, "?" if the question asks for it, null if not relevant.
   - Optionally add a "Total" row if it helps understanding.
   - "unitValue" = value of 1 unit after solving.
   - Maximum 5 rows per step, units must be 1-10.
   For all other question types, set "diagrams": [].

Rules:
- topic must be copied EXACTLY from the list, or null if no match.
- Do NOT invent or paraphrase topic names.
- Write ALL math in plain text only. No LaTeX, no markdown. Use: 3/5 (not \\frac{3}{5}), x or * for multiply, ÷ for divide, ^ for powers. Never use $, \\, {, } in the solution.

Respond with ONLY valid JSON (no markdown fences):
{
  "subject": "Math" or "Science" or "English",
  "topic": "<exact topic from list, or null>",
  "solution": "<step-by-step solution, use \\n for line breaks>",
  "diagrams": [{ "title": "...", "rows": [...], "unitValue": "..." }]
}`;

  try {
    const ai = getAI();
    const response = await ai.chat.completions.create({
      model: "gpt-5.4",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageBase64, detail: "high" } },
          { type: "text", text: prompt },
        ],
      }],
      temperature: 0.2,
    });

    const text = (response.choices[0]?.message?.content ?? "").trim();
    const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(jsonStr);

    // Validate topic is actually in our list
    const allTopics = [...MATH_TOPICS, ...SCIENCE_TOPICS];
    const rawTopic: string | null = parsed.topic ?? null;
    const validTopic = rawTopic && allTopics.includes(rawTopic) ? rawTopic : null;

    // Validate diagrams array
    type RawRow = { label?: unknown; units?: unknown; value?: unknown };
    const rawDiagrams = Array.isArray(parsed.diagrams) ? parsed.diagrams : [];
    const diagrams = rawDiagrams
      .map((d: { title?: unknown; rows?: unknown; unitValue?: unknown }) => {
        if (!Array.isArray(d.rows)) return null;
        const validRows = (d.rows as RawRow[]).filter(
          r => typeof r.label === "string" && typeof r.units === "number" && r.units >= 1 && r.units <= 10
        );
        if (validRows.length === 0) return null;
        return {
          title: typeof d.title === "string" ? d.title : null,
          rows: validRows,
          unitValue: typeof d.unitValue === "string" ? d.unitValue : null,
        };
      })
      .filter(Boolean);

    return NextResponse.json({
      subject: parsed.subject ?? "Math",
      topic: validTopic,
      solution: parsed.solution ?? "",
      diagrams,
    });
  } catch (err) {
    console.error("[solver] OpenAI error:", err);
    return NextResponse.json({ error: "Failed to solve question" }, { status: 500 });
  }
}
