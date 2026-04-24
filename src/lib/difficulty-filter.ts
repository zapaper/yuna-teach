import { prisma } from "@/lib/db";

export type DifficultyMode = "easier" | "adaptive" | "standard" | "hard";

export const DIFFICULTY_MODES: DifficultyMode[] = ["easier", "adaptive", "standard", "hard"];

/** The 1-5 levels considered "primary" for a given mode. Mode=standard
 *  returns null — apply no filter at all (draw freely from every level). */
export function primaryLevelsFor(mode: DifficultyMode): number[] | null {
  switch (mode) {
    case "easier":
    case "adaptive":
      return [1, 2, 3];
    case "hard":
      return [3, 4, 5];
    case "standard":
    default:
      return null;
  }
}

/** Fallback levels used when the primary bucket has too few questions. */
export function fallbackLevelsFor(mode: DifficultyMode): number[] | null {
  switch (mode) {
    case "easier":
    case "adaptive":
      return [4];
    case "hard":
      return [1, 2];
    case "standard":
    default:
      return null;
  }
}

/** Read the student's chosen difficulty mode from their user settings. */
export async function getStudentDifficultyMode(studentId: string | null | undefined): Promise<DifficultyMode> {
  if (!studentId) return "standard";
  const u = await prisma.user.findUnique({
    where: { id: studentId },
    select: { settings: true },
  });
  const raw = ((u?.settings as Record<string, unknown> | null) ?? {}).questionDifficulty as unknown;
  if (raw === "easier" || raw === "adaptive" || raw === "standard" || raw === "hard") return raw;
  return "standard";
}

/** For adaptive mode: the student is "performing well" on a subject if
 *  their last 3 completed quiz/focused/exam papers in that subject
 *  averaged above 80 %. When this returns true, adaptive mode broadens
 *  to the full 1-5 range (same as standard). */
export async function isAdaptivelyReady(studentId: string, subject: string): Promise<boolean> {
  if (!studentId || !subject) return false;
  const recent = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      completedAt: { not: null },
      markingStatus: { in: ["complete", "released"] },
      subject: { contains: subject, mode: "insensitive" },
      score: { not: null },
      totalMarks: { not: null },
    },
    orderBy: { completedAt: "desc" },
    take: 3,
    select: { score: true, totalMarks: true },
  });
  if (recent.length < 3) return false;
  let totalPct = 0;
  for (const p of recent) {
    const total = parseFloat(p.totalMarks ?? "0");
    if (!total) return false;
    totalPct += ((p.score ?? 0) / total) * 100;
  }
  return totalPct / 3 > 80;
}

/** Resolve a mode against the student's recent performance into the
 *  effective primary/fallback level filter. "standard" and unlocked
 *  "adaptive" both return { primary: null } (no filter). */
export async function resolveDifficultyFilter(
  mode: DifficultyMode,
  studentId: string | null | undefined,
  subject: string | null | undefined,
): Promise<{ effectiveMode: DifficultyMode; primary: number[] | null; fallback: number[] | null }> {
  if (mode === "standard") return { effectiveMode: "standard", primary: null, fallback: null };

  if (mode === "adaptive" && studentId && subject) {
    const unlocked = await isAdaptivelyReady(studentId, subject);
    if (unlocked) return { effectiveMode: "standard", primary: null, fallback: null };
  }

  return {
    effectiveMode: mode,
    primary: primaryLevelsFor(mode),
    fallback: fallbackLevelsFor(mode),
  };
}

/** Short human-readable label for warnings, e.g. "easier-only filter".
 *  Used in the parent-visible warning banner when the student's chosen
 *  difficulty left too few questions. */
export function modeWarningLabel(mode: DifficultyMode): string {
  switch (mode) {
    case "easier": return "easier-questions filter";
    case "adaptive": return "adaptive easier-start filter";
    case "hard": return "hard-only filter";
    case "standard": return "standard difficulty";
  }
}
