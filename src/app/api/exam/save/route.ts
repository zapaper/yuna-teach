import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      title,
      school,
      level,
      subject,
      year,
      semester,
      pageCount,
      userId,
      questions,
    } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    if (!title) {
      return NextResponse.json(
        { error: "title is required" },
        { status: 400 }
      );
    }

    const paper = await prisma.examPaper.create({
      data: {
        title,
        school: school || null,
        level: level || null,
        subject: subject || null,
        year: year || null,
        semester: semester || null,
        pageCount: pageCount || 0,
        userId,
        questions: {
          create: questions.map(
            (q: {
              questionNum: string;
              imageData: string;
              answer?: string;
              answerImageData?: string;
              pageIndex: number;
              orderIndex: number;
              yStartPct?: number;
              yEndPct?: number;
            }) => ({
              questionNum: q.questionNum,
              imageData: q.imageData,
              answer: q.answer || null,
              answerImageData: q.answerImageData || null,
              pageIndex: q.pageIndex,
              orderIndex: q.orderIndex,
              yStartPct: q.yStartPct ?? null,
              yEndPct: q.yEndPct ?? null,
            })
          ),
        },
      },
      include: {
        questions: { orderBy: { orderIndex: "asc" } },
      },
    });

    return NextResponse.json(paper, { status: 201 });
  } catch (error) {
    console.error("Save exam error:", error);
    return NextResponse.json(
      { error: "Failed to save exam paper" },
      { status: 500 }
    );
  }
}
