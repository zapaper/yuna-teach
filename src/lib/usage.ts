import { prisma } from "@/lib/db";

/** Free-tier monthly limits per parent user */
export const FREE_LIMITS = {
  exam: 1,
  quiz: 1,
  spelling: 1,
  solver: 3,
} as const;

export type UsageType = keyof typeof FREE_LIMITS;

/** Check if a parent user has an active subscription */
export async function isPaidUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionStatus: true },
  });
  return user?.subscriptionStatus === "active";
}

/** Count usage for the current calendar month */
export async function getMonthlyUsage(userId: string): Promise<Record<UsageType, number>> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Get all linked student IDs for this parent
  const links = await prisma.parentStudent.findMany({
    where: { parentId: userId },
    select: { studentId: true },
  });
  const studentIds = links.map(l => l.studentId);
  const allUserIds = [userId, ...studentIds];

  const [exams, quizzes, spellingTests, solverCount] = await Promise.all([
    // Exams: papers uploaded by parent or assigned to students, created this month, not quizzes/focused
    prisma.examPaper.count({
      where: {
        userId,
        paperType: null,
        sourceExamId: { not: null }, // assigned (cloned) papers
        createdAt: { gte: monthStart },
      },
    }),
    // Quizzes: quiz papers created this month
    prisma.examPaper.count({
      where: {
        userId,
        paperType: "quiz",
        createdAt: { gte: monthStart },
      },
    }),
    // Spelling tests: created by any linked user this month
    prisma.spellingTest.count({
      where: {
        userId: { in: allUserIds },
        createdAt: { gte: monthStart },
      },
    }),
    // Solver: count from metadata (we'll track via a simple counter approach)
    // For now, count solver usage from a lightweight approach
    prisma.examPaper.count({
      where: {
        userId: { in: allUserIds },
        paperType: "solver",
        createdAt: { gte: monthStart },
      },
    }),
  ]);

  return {
    exam: exams,
    quiz: quizzes,
    spelling: spellingTests,
    solver: solverCount,
  };
}

/** Check if the user can perform an action (returns true if allowed) */
export async function canUse(userId: string, type: UsageType): Promise<boolean> {
  if (await isPaidUser(userId)) return true;
  const usage = await getMonthlyUsage(userId);
  return usage[type] < FREE_LIMITS[type];
}

/** Get remaining free uses for a type */
export async function remainingFreeUses(userId: string, type: UsageType): Promise<number> {
  if (await isPaidUser(userId)) return Infinity;
  const usage = await getMonthlyUsage(userId);
  return Math.max(0, FREE_LIMITS[type] - usage[type]);
}
