import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guardCanAssign } from "@/lib/subscription";
import { resolveActor } from "@/lib/auth-guard";

export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("userId");
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;

  const tests = await prisma.spellingTest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { words: true } },
    },
  });

  return NextResponse.json({
    tests: tests.map((t) => ({
      id: t.id,
      title: t.title,
      subtitle: t.subtitle,
      language: t.language,
      wordCount: t._count.words,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { title, subtitle, language, imageData, words, userId } = body;

  if (!userId) {
    return NextResponse.json(
      { error: "userId is required" },
      { status: 400 }
    );
  }

  const blocked = await guardCanAssign(userId);
  if (blocked) return blocked;

  const test = await prisma.spellingTest.create({
    data: {
      title,
      subtitle: subtitle || null,
      language: language || "CHINESE",
      imageUrl: imageData || null,
      userId,
      words: {
        create: words.map(
          (w: { text: string; orderIndex: number; enabled?: boolean; pairedText?: string }) => ({
            text: w.text,
            orderIndex: w.orderIndex,
            enabled: w.enabled !== false,
            pairedText: w.pairedText ?? null,
          })
        ),
      },
    },
    include: { words: { orderBy: { orderIndex: "asc" } } },
  });

  return NextResponse.json(test, { status: 201 });
}
