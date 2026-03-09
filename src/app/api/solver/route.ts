import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

function getAI() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
}

const MATH_TOPICS = [
  "Whole Numbers", "Fractions", "Decimals", "Percentage", "Ratio",
  "Rate and Speed", "Algebra", "Functions and Graphs",
  "Geometry", "Angles", "Area and Perimeter", "Volume",
  "Data Analysis", "Probability", "Average", "Money",
  "Time", "Measurement",
];

const SCIENCE_TOPICS = [
  "Diversity", "Cycles", "Systems", "Interactions", "Energy",
  "Plants", "Animals", "Fungi and Bacteria", "Human Body",
  "Matter", "Heat", "Light", "Forces", "Electricity",
  "Water Cycle", "Reproduction", "Life Cycles", "Photosynthesis",
  "Food Chains", "Ecosystems",
];

export async function POST(request: NextRequest) {
  const { imageBase64 } = await request.json();
  if (!imageBase64) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }

  // Strip data URL prefix if present
  const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");

  const prompt = `You are an expert primary school tutor. Analyse this question image and respond in JSON.

Steps:
1. Identify the subject: "Math" or "Science".
2. Identify the specific syllabus topic from the relevant list below.
   Math topics: ${MATH_TOPICS.join(", ")}
   Science topics: ${SCIENCE_TOPICS.join(", ")}
   Pick the single closest match from the list above.
3. Provide a clear, step-by-step solution suitable for a primary school student.

Respond with ONLY valid JSON (no markdown fences):
{
  "subject": "Math" or "Science",
  "topic": "<closest topic from the list>",
  "solution": "<step-by-step solution, use \\n for line breaks>"
}`;

  try {
    const response = await getAI().models.generateContent({
      model: "gemini-2.5-flash",
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

    return NextResponse.json({
      subject: parsed.subject ?? "Math",
      topic: parsed.topic ?? "",
      solution: parsed.solution ?? "",
    });
  } catch (err) {
    console.error("[solver] Gemini error:", err);
    return NextResponse.json({ error: "Failed to solve question" }, { status: 500 });
  }
}
