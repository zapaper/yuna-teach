import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const test = await prisma.spellingTest.findUnique({
    where: { id },
    include: { words: { orderBy: { orderIndex: "asc" } } },
  });

  if (!test) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: test.id,
    title: test.title,
    subtitle: test.subtitle,
    language: test.language,
    imageUrl: test.imageUrl,
    createdAt: test.createdAt.toISOString(),
    words: test.words.map((w) => ({
      id: w.id,
      text: w.text,
      orderIndex: w.orderIndex,
      enabled: w.enabled,
    })),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { title } = await request.json();

  if (!title || typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const test = await prisma.spellingTest.update({
    where: { id },
    data: { title: title.trim() },
  });

  return NextResponse.json({ id: test.id, title: test.title });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  await prisma.spellingTest.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
