import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { getMasterClass } from "@/data/master-class";

// GET /api/admin/master-class/[slug]
//   ?excludeIds=cmp...,cmp...   — skip questions already shown (for "more practice")
// Returns the Master Class content plus a fresh draw of practice
// questions (5 MCQ + 5 OEQ) from the master bank, filtered to the
// topic's syllabusTopic + subject + Primary 6 / PSLE level.

const PRACTICE_BATCH_MCQ = 5;
const PRACTICE_BATCH_OEQ = 5;

export async function GET(_req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { name: true, settings: true },
  });
  if (!isAdmin(me)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { slug } = await context.params;
  const content = getMasterClass(slug);
  if (!content) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });

  const excludeParam = _req.nextUrl.searchParams.get("excludeIds") ?? "";
  const excludeIds = excludeParam.split(",").map(s => s.trim()).filter(Boolean);

  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { equals: content.topicLabel, mode: "insensitive" },
      transcribedStem: { not: null },
      ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: content.subject, mode: "insensitive" },
        OR: [
          { level: { contains: "Primary 6", mode: "insensitive" } },
          { level: { contains: "P6", mode: "insensitive" } },
          { level: { contains: "PSLE", mode: "insensitive" } },
          { level: { contains: "Primary School", mode: "insensitive" } },
        ],
      },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      marksAvailable: true,
      examPaper: { select: { title: true, year: true } },
    },
  });

  const isPsle = (title: string) => /\bPSLE\b/i.test(title);
  const mcqAll = candidates.filter(q => Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4);
  const oeqAll = candidates.filter(q => !Array.isArray(q.transcribedOptions) || (q.transcribedOptions as unknown[]).length !== 4);

  // Prefer a PSLE-first mix so the curated set leads with actual exam Q's
  // and then tops up from school-bank questions. Random within each tier
  // so re-running "more practice" doesn't repeat the same items.
  function pick<T extends { examPaper: { title: string } }>(arr: T[], n: number): T[] {
    const psle = arr.filter(q => isPsle(q.examPaper.title)).sort(() => Math.random() - 0.5);
    const school = arr.filter(q => !isPsle(q.examPaper.title)).sort(() => Math.random() - 0.5);
    return [...psle, ...school].slice(0, n);
  }
  const mcq = pick(mcqAll, PRACTICE_BATCH_MCQ);
  const oeq = pick(oeqAll, PRACTICE_BATCH_OEQ);

  return NextResponse.json({
    content,
    practice: {
      mcq,
      oeq,
      poolSize: candidates.length,
      mcqPool: mcqAll.length,
      oeqPool: oeqAll.length,
    },
  });
}
