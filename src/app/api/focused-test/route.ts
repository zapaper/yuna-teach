import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(request: NextRequest) {
  const { parentId, studentId, subject, topic } = await request.json();

  if (!parentId || !subject || !topic) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Determine level filter from student
  let levelFilter: string | undefined;
  if (studentId) {
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { level: true },
    });
    if (student?.level) {
      levelFilter = `Primary ${student.level}`;
    }
  }

  // Find questions from master papers matching subject + topic + level
  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: topic,
      answer: { not: null },
      examPaper: {
        sourceExamId: null, // master papers only
        subject: { contains: subject, mode: "insensitive" },
        ...(levelFilter ? { level: levelFilter } : {}),
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

  const paper = await prisma.examPaper.create({
    data: {
      title: `Focused Test on ${topic}`,
      subject,
      level: levelFilter || null,
      userId: parentId,
      assignedToId: studentId || null,
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
