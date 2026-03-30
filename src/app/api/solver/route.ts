import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { readFileSync } from "fs";
import path from "path";

function getAI() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
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

  const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");

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
4. If the question involves ratio, fractions, percentages, or comparing/sharing quantities between people or groups, ALSO return a "diagram" field with a Singapore model method bar diagram:
   {
     "type": "bar",
     "rows": [{ "label": "<name or quantity>", "units": <integer 1-10>, "value": "<known value, '?' if unknown, or null>" }],
     "unitValue": "<value of 1 unit if determinable, else null>"
   }
   Rules for diagram:
   - Each row = one person/quantity being compared (e.g. one row per person in ratio, or "Shaded"/"Unshaded" for fractions)
   - "units" = the ratio or fraction number (e.g. ratio 3:5 → units 3 and 5)
   - "value" = the actual quantity if known/solved, "?" if the question asks for it, null if not relevant
   - Optionally add a final "Total" row if it helps understanding
   - "unitValue" = value of 1 unit after solving (e.g. if 8 units = 320, unitValue = "40")
   - Maximum 5 rows, units must be 1-10
   For all other question types, set "diagram": null.

Rules:
- topic must be copied EXACTLY from the list, or null if no match.
- Do NOT invent or paraphrase topic names.

Respond with ONLY valid JSON (no markdown fences):
{
  "subject": "Math" or "Science" or "English",
  "topic": "<exact topic from list, or null>",
  "solution": "<step-by-step solution, use \\n for line breaks>",
  "diagram": { "type": "bar", "rows": [...], "unitValue": "..." } or null
}`;

  try {
    const response = await getAI().models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: base64Data } },
          { text: prompt },
        ],
      }],
      config: { temperature: 0.2 },
    });

    const text = (response.text ?? "").trim();
    const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(jsonStr);

    // Validate topic is actually in our list
    const allTopics = [...MATH_TOPICS, ...SCIENCE_TOPICS];
    const rawTopic: string | null = parsed.topic ?? null;
    const validTopic = rawTopic && allTopics.includes(rawTopic) ? rawTopic : null;

    // Validate diagram if present
    let diagram: object | null = null;
    const raw = parsed.diagram;
    if (raw && raw.type === "bar" && Array.isArray(raw.rows) && raw.rows.length > 0) {
      const validRows = raw.rows.filter(
        (r: { label?: unknown; units?: unknown; value?: unknown }) =>
          typeof r.label === "string" &&
          typeof r.units === "number" &&
          r.units >= 1 && r.units <= 10
      );
      if (validRows.length > 0) {
        diagram = { type: "bar", rows: validRows, unitValue: typeof raw.unitValue === "string" ? raw.unitValue : null };
      }
    }

    return NextResponse.json({
      subject: parsed.subject ?? "Math",
      topic: validTopic,
      solution: parsed.solution ?? "",
      diagram,
    });
  } catch (err) {
    console.error("[solver] Gemini error:", err);
    return NextResponse.json({ error: "Failed to solve question" }, { status: 500 });
  }
}
