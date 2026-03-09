import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

function getAI() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
}

// Exact topics as they exist in the database
const MATH_TOPICS = [
  "Percentage",
  "Geometry",
  "Basic math operations",
  "Time",
  "Statistics",
  "Fractions",
  "Volume of cube and cuboid",
  "Algebra",
  "Area and circumference of circle",
  "Ratio",
  "Volume measurement",
];

const SCIENCE_TOPICS = [
  "Diversity of living and non-living things",
  "Diversity of materials",
  "Life cycles in plants and animals",
  "Plant parts and functions",
  "Human digestive system",
  "Cycles in matter",
  "Water cycle",
  "Plant respiratory and circulatory systems",
  "Human respiratory and circulatory systems",
  "Reproduction in plants and animals",
  "Light energy and uses",
  "Heat energy and uses",
  "Electrical system and circuits",
  "Photosynthesis",
  "Energy conversion",
  "Interaction of forces (Magnets)",
  "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
  "Interactions within the environment",
];

export async function POST(request: NextRequest) {
  const { imageBase64 } = await request.json();
  if (!imageBase64) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }

  const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");

  const prompt = `You are an expert primary school tutor. Analyse this question image and respond in JSON.

Steps:
1. Identify the subject: "Math" or "Science".
2. Match to ONE topic from the exact list below. You MUST pick a topic from the list word-for-word, or return null if none fits.
   Math topics:
   ${MATH_TOPICS.map((t) => `- "${t}"`).join("\n   ")}
   Science topics:
   ${SCIENCE_TOPICS.map((t) => `- "${t}"`).join("\n   ")}
3. Provide a clear, step-by-step solution suitable for a primary school student.

Rules:
- topic must be copied EXACTLY from the list, or null if no match.
- Do NOT invent or paraphrase topic names.

Respond with ONLY valid JSON (no markdown fences):
{
  "subject": "Math" or "Science",
  "topic": "<exact topic from list, or null>",
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

    // Validate topic is actually in our list
    const allTopics = [...MATH_TOPICS, ...SCIENCE_TOPICS];
    const rawTopic: string | null = parsed.topic ?? null;
    const validTopic = rawTopic && allTopics.includes(rawTopic) ? rawTopic : null;

    return NextResponse.json({
      subject: parsed.subject ?? "Math",
      topic: validTopic,
      solution: parsed.solution ?? "",
    });
  } catch (err) {
    console.error("[solver] Gemini error:", err);
    return NextResponse.json({ error: "Failed to solve question" }, { status: 500 });
  }
}
