import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(request: NextRequest) {
  const { parentId, studentId, subject, topic } = await request.json();

  if (!parentId || !studentId || !subject || !topic) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Verify parent-student link
  const link = await prisma.parentStudent.findFirst({
    where: { parentId, studentId },
  });
  if (!link) {
    return NextResponse.json({ error: "Not linked" }, { status: 403 });
  }

  // Find questions from parent's master papers matching subject + topic
  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: topic,
      answer: { not: null },
      examPaper: {
        userId: parentId,
        sourceExamId: null, // master papers only
        subject: { contains: subject, mode: "insensitive" },
      },
    },
    select: {
      questionNum: true,
      imageData: true,
      answer: true,
      answerImageData: true,
      marksAvailable: true,
      syllabusTopic: true,
    },
  });

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "No questions found for this topic" },
      { status: 404 }
    );
  }

  // Shuffle and take up to 10
  const shuffled = candidates.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 10);

  // Get student name for title
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { name: true },
  });

  const paper = await prisma.examPaper.create({
    data: {
      title: `Focused Test: ${topic}`,
      subject,
      userId: parentId,
      assignedToId: studentId,
      paperType: "focused",
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(
        selected.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0)
      ),
      questions: {
        create: selected.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          marksAvailable: q.marksAvailable ?? 1,
          syllabusTopic: q.syllabusTopic,
          pageIndex: 0,
          orderIndex: i,
        })),
      },
    },
  });

  return NextResponse.json({ id: paper.id });
}
