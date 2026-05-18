import { prisma } from "../src/lib/db";

// Count attempted "written" (OEQ) questions, excluding test users
// admin + student666. A question counts as written-attempted when:
//   • it has no MCQ shape (transcribedOptions / transcribedOptionImages
//     / transcribedOptionTable all empty)
//   • studentAnswer is non-empty AND not "__SKIPPED__"
// Tallied per assigned student so the breakdown shows who's actually
// using the OEQ flow.

(async () => {
  // Match case-insensitively — the actual DB rows use mixed case
  // ("Student666 (Pop's test account)" etc.) and a literal notIn
  // would let them slip through.
  const excludedNames = ["admin", "student666"];
  const excludedRe = /^(admin|student666)$/i;

  const questions = await prisma.examQuestion.findMany({
    where: {
      studentAnswer: { not: null },
      examPaper: {
        assignedTo: {
          NOT: excludedNames.map((n) => ({
            name: { equals: n, mode: "insensitive" as const },
          })),
        },
      },
    },
    select: {
      id: true,
      studentAnswer: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedOptionTable: true,
      answer: true,
      examPaper: {
        select: {
          id: true,
          subject: true,
          assignedTo: { select: { id: true, name: true, displayName: true } },
        },
      },
    },
  });

  const isMcq = (
    opts: unknown,
    optImgs: unknown,
    optTable: unknown,
    answer: string | null,
  ) => {
    if (Array.isArray(opts) && opts.length === 4 && opts.some((o) => o)) return true;
    if (Array.isArray(optImgs) && optImgs.some((o) => !!o)) return true;
    if (optTable && typeof optTable === "object") {
      const t = optTable as { rows?: unknown[] };
      if (Array.isArray(t.rows) && t.rows.length === 4) return true;
    }
    const a = (answer ?? "").trim().replace(/[().]/g, "");
    return a === "1" || a === "2" || a === "3" || a === "4";
  };

  type PerStudent = {
    studentId: string;
    name: string;
    displayName: string | null;
    total: number;
    bySubject: Map<string, number>;
  };
  const byStudent = new Map<string, PerStudent>();
  let grandTotal = 0;

  for (const q of questions) {
    const ans = (q.studentAnswer ?? "").trim();
    if (!ans) continue;
    if (ans === "__SKIPPED__") continue;
    if (
      isMcq(
        q.transcribedOptions,
        q.transcribedOptionImages,
        q.transcribedOptionTable,
        q.answer,
      )
    ) {
      continue;
    }
    const assignee = q.examPaper.assignedTo;
    if (!assignee) continue;
    // Defence-in-depth: case-insensitive name filter at the JS level
    // in case the DB filter ever drifts.
    if (excludedRe.test(assignee.name)) continue;
    const subject = (q.examPaper.subject ?? "unknown").toLowerCase();

    grandTotal++;
    const entry =
      byStudent.get(assignee.id) ??
      ({
        studentId: assignee.id,
        name: assignee.name,
        displayName: assignee.displayName,
        total: 0,
        bySubject: new Map(),
      } satisfies PerStudent);
    entry.total++;
    entry.bySubject.set(subject, (entry.bySubject.get(subject) ?? 0) + 1);
    byStudent.set(assignee.id, entry);
  }

  console.log(`${"=".repeat(70)}`);
  console.log(`Attempted written (OEQ) questions — excluding ${excludedNames.join(", ")}`);
  console.log(`${"=".repeat(70)}\n`);

  const ranked = [...byStudent.values()].sort((a, b) => b.total - a.total);
  for (const s of ranked) {
    const label = s.displayName ? `${s.name} (${s.displayName})` : s.name;
    const subjects = [...s.bySubject.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.log(`  ${String(s.total).padStart(5)}  ${label.padEnd(28)}  ${subjects}`);
  }
  console.log(`\n  ${"=".repeat(45)}`);
  console.log(`  ${String(grandTotal).padStart(5)}  TOTAL across ${ranked.length} student${ranked.length === 1 ? "" : "s"}`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
