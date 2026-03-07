import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _ai;
}

// POST /api/exam/[id]/elaborate
// Body: { questionId }
// Returns: { elaboration: string }
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { questionId } = await request.json();

  if (!questionId) {
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
  }

  const question = await prisma.examQuestion.findFirst({
    where: { id: questionId, examPaperId: id },
    select: {
      questionNum: true,
      answer: true,
      marksAvailable: true,
      marksAwarded: true,
      markingNotes: true,
      imageData: true,
      studentAnswer: true,
      elaboration: true,
    },
  });

  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  // Return cached elaboration if available
  if (question.elaboration) {
    return NextResponse.json({ elaboration: question.elaboration });
  }

  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];

  // Include the question image if available
  if (question.imageData) {
    const match = question.imageData.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }

  parts.push({
    text: `You are a helpful tutor for a primary/secondary school student.

Here is an exam question the student needs help with.

Question number: ${question.questionNum}
Correct answer: ${question.answer ?? "Not provided"}

Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it. Do NOT discuss what the student did wrong or why they lost marks — just teach the correct approach.

Keep the explanation concise (under 200 words), age-appropriate, and encouraging. Use simple language. If the question image is provided, reference the actual question content.`,
  });

  try {
    const response = await getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
    });

    const elaboration = response.text ?? "Unable to generate explanation.";

    // Cache the elaboration in the database
    await prisma.examQuestion.update({
      where: { id: questionId },
      data: { elaboration },
    });

    return NextResponse.json({ elaboration });
  } catch (err) {
    console.error("Elaboration failed:", err);
    return NextResponse.json(
      { error: "Failed to generate elaboration" },
      { status: 500 }
    );
  }
}
