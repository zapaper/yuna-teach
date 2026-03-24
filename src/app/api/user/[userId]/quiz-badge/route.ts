import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/user/:userId/quiz-badge
 *
 * Returns the user's current quiz badge tier and whether a NEW badge
 * was just earned (i.e. the completed quiz count exactly hits a milestone).
 *
 * Milestones:
 *   1 quiz  → Bronze Quizzer
 *   3 quizzes → Silver Quizzer
 *  10 quizzes → Gold Quizzer
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;

  // Single query: get completed quiz dates (used for count, badge, and streak)
  const completedQuizzes = await prisma.examPaper.findMany({
    where: { assignedToId: userId, paperType: "quiz", completedAt: { not: null } },
    select: { completedAt: true },
    orderBy: { completedAt: "desc" },
  });
  const count = completedQuizzes.length;

  // Determine current badge tier
  let badge: string | null = null;
  let image: string | null = null;
  if (count >= 10) {
    badge = "Gold Quizzer";
    image = "/goldquizzer.png";
  } else if (count >= 3) {
    badge = "Silver Quizzer";
    image = "/silverquizzer.png";
  } else if (count >= 1) {
    badge = "Bronze Quizzer";
    image = "/bronzequizzer.png";
  }

  // Check if the user JUST hit a milestone (new badge)
  const milestones: { count: number; badge: string; image: string; message: string }[] = [
    {
      count: 1,
      badge: "Bronze Quizzer",
      image: "/bronzequizzer.png",
      message: "Congratulations on completing your first daily quiz! You have earned the Bronze Quizzer badge.",
    },
    {
      count: 3,
      badge: "Silver Quizzer",
      image: "/silverquizzer.png",
      message: "Amazing effort! 3 daily quizzes completed! You have earned the Silver Quizzer badge.",
    },
    {
      count: 10,
      badge: "Gold Quizzer",
      image: "/goldquizzer.png",
      message: "Incredible dedication! 10 daily quizzes completed! You have earned the Gold Quizzer badge.",
    },
  ];

  const newBadge = milestones.find(m => m.count === count) ?? null;

  // Calculate streak — count consecutive days with at least one completed quiz
  let streak = 0;
  if (completedQuizzes.length > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayMs = 86400000;
    const quizDays = new Set(
      completedQuizzes.map(q => {
        const d = new Date(q.completedAt!);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      })
    );
    // Check if today or yesterday has a quiz (to start the streak)
    let checkDay = today.getTime();
    if (!quizDays.has(checkDay)) {
      checkDay = today.getTime() - dayMs; // allow yesterday
      if (!quizDays.has(checkDay)) checkDay = 0; // no streak
    }
    if (checkDay > 0) {
      while (quizDays.has(checkDay)) {
        streak++;
        checkDay -= dayMs;
      }
    }
  }

  return NextResponse.json({
    completedQuizzes: count,
    badge,
    badgeImage: image,
    streak,
    newBadge: newBadge ? { badge: newBadge.badge, image: newBadge.image, message: newBadge.message } : null,
  });
}
