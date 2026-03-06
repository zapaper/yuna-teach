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
    },
  });

  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
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

The student got this exam question wrong (or partially wrong).

Question number: ${question.questionNum}
Correct answer: ${question.answer ?? "Not provided"}
Student's answer: ${question.studentAnswer ?? "See their work in the image"}
Marks awarded: ${question.marksAwarded ?? 0} / ${question.marksAvailable ?? 0}
Marking notes: ${question.markingNotes ?? "None"}

Please provide a clear, student-friendly explanation of:
1. What the correct answer is and why
2. A step-by-step explanation of how to arrive at the correct answer
3. Common mistakes students make on this type of question

Keep the explanation concise (under 200 words), age-appropriate, and encouraging. Use simple language. If the question image is provided, reference the actual question content.`,
  });

  try {
    const response = await getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
    });

    const elaboration = response.text ?? "Unable to generate explanation.";
    return NextResponse.json({ elaboration });
  } catch (err) {
    console.error("Elaboration failed:", err);
    return NextResponse.json(
      { error: "Failed to generate elaboration" },
      { status: 500 }
    );
  }
}
