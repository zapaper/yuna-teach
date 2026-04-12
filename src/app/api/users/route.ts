import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      parentLinks: { include: { student: { select: { id: true, name: true, level: true, settings: true } } } },
      studentLinks: { include: { parent: { select: { id: true, name: true } } } },
    },
  });

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      level: u.level,
      settings: u.settings,
      createdAt: u.createdAt.toISOString(),
      linkedStudents: u.parentLinks.map((l) => ({ ...l.student, settings: l.student.settings as Record<string, boolean> | null })),
      linkedParents: u.studentLinks.map((l) => l.parent),
    })),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, role, level, email, password, parentId } = body;

  if (!name || !role || !password) {
    return NextResponse.json(
      { error: "Name, role, and password are required" },
      { status: 400 }
    );
  }

  // Students: name must be unique
  if (role === "STUDENT") {
    const existing = await prisma.user.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, role: "STUDENT" },
    });
    if (existing) {
      return NextResponse.json(
        { error: "This username is already taken" },
        { status: 409 }
      );
    }
  }

  // Parents: email required and must be unique
  if (role === "PARENT") {
    if (!email) {
      return NextResponse.json(
        { error: "Email is required for parent accounts" },
        { status: 400 }
      );
    }
    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "This email is already registered" },
        { status: 409 }
      );
    }
  }

  const user = await prisma.user.create({
    data: {
      name,
      role,
      password,
      email: role === "PARENT" ? email : null,
      level: role === "STUDENT" ? (level ?? 1) : null,
    },
  });

  // Auto-link student to parent if parentId provided
  if (role === "STUDENT" && parentId) {
    try {
      await prisma.parentStudent.create({
        data: { parentId, studentId: user.id },
      });
    } catch (err) {
      console.error("Failed to auto-link student to parent:", err);
    }
  }

  // Clone template exam papers to new parents
  if (role === "PARENT") {
    try {
      // Find the template parent (first PARENT user — "Papa")
      const templateParent = await prisma.user.findFirst({
        where: { role: "PARENT" },
        orderBy: { createdAt: "asc" },
      });
      if (templateParent && templateParent.id !== user.id) {
        // Get master papers (not clones) from template parent
        const templatePapers = await prisma.examPaper.findMany({
          where: { userId: templateParent.id, sourceExamId: null },
          include: { questions: true },
        });
        for (const tp of templatePapers) {
          await prisma.examPaper.create({
            data: {
              title: tp.title,
              school: tp.school,
              level: tp.level,
              subject: tp.subject,
              year: tp.year,
              semester: tp.semester,
              totalMarks: tp.totalMarks,
              metadata: tp.metadata ?? undefined,
              pdfPath: tp.pdfPath,
              pageCount: tp.pageCount,
              userId: user.id,
              questions: {
                create: tp.questions.map((q) => ({
                  questionNum: q.questionNum,
                  imageData: q.imageData,
                  answer: q.answer,
                  answerImageData: q.answerImageData,
                  pageIndex: q.pageIndex,
                  orderIndex: q.orderIndex,
                  yStartPct: q.yStartPct,
                  yEndPct: q.yEndPct,
                  marksAvailable: q.marksAvailable,
                })),
              },
            },
          });
        }
      }
    } catch (err) {
      console.error("Failed to clone template papers:", err);
    }
  }

  return NextResponse.json(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      level: user.level,
      createdAt: user.createdAt.toISOString(),
      linkedStudents: [],
      linkedParents: [],
    },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const { userId, settings } = await request.json();
  if (!userId || !settings) {
    return NextResponse.json({ error: "userId and settings required" }, { status: 400 });
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const merged = { ...((user.settings as Record<string, unknown>) ?? {}), ...settings };
  await prisma.user.update({ where: { id: userId }, data: { settings: merged } });
  return NextResponse.json({ success: true, settings: merged });
}
