import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/admin";
import { bumpUserActivity } from "@/lib/track-activity";
import { resolveActor } from "@/lib/auth-guard";

export async function GET(request: NextRequest) {
  // Caller from session. Admins may pass ?userId=<target> to view
  // another user's papers (legacy admin "view as user"); non-admins
  // ignoring the param means they cannot read another family's data.
  const target = request.nextUrl.searchParams.get("userId");
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;
  // Touch lastLoginAt so the admin "Last active" stamp tracks
  // dashboard refreshes, not just sign-ins. Throttled to one DB
  // write per user per 5 min — see track-activity.ts.
  bumpUserActivity(userId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let where: any = undefined;
  let linkedStudentIds: string[] | null = null; // null = no filter (admin), [] = no students
  // Determine role + admin flag in a single round-trip. Used to be two
  // separate findUnique calls (role here, name/settings later in the
  // Chinese-gating block) — same row, redundant query.
  let role: string | undefined;
  let actorIsAdmin = false;
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, name: true, settings: true },
    });
    role = user?.role;
    actorIsAdmin = isAdmin(user);

    if (role === "STUDENT") {
      // Exclude paperType="eval" clones (created by the regression
      // eval harness) — they're assigned to the same student as the
      // source paper but must not surface in the student's dashboard.
      // Explicit OR because Prisma's `{ not: "eval" }` excludes nulls
      // by default and most real papers have paperType=null.
      where = {
        assignedToId: userId,
        OR: [
          { paperType: null },
          { paperType: { not: "eval" } },
        ],
      };
    } else {
      // Parents see master papers + focused tests (exclude clones)
      // Filter to only levels matching their linked students
      const links = await prisma.parentStudent.findMany({
        where: { parentId: userId },
        include: { student: { select: { id: true, level: true } } },
      });
      linkedStudentIds = links.map((l) => l.student.id);
      const studentLevels = links
        .map((l) => l.student.level)
        .filter((v): v is number => v != null);

      // actorIsAdmin already resolved at the top of GET — re-use it
      // rather than a second findUnique on the same parent row.
      const isAdminUser = actorIsAdmin;

      if (studentLevels.length > 0) {
        // Match levels with various formats: "Primary 5", "Pr 5", "P5", etc.
        const levelConditions = studentLevels.flatMap((n) => [
          { level: { contains: String(n) } },
        ]);
        if (isAdminUser) {
          // Admin sees all master papers; focused tests only if admin created them for themselves
          where = {
            OR: [
              { sourceExamId: null, paperType: null },
              { sourceExamId: null, paperType: "focused", userId, assignedToId: null },
              { sourceExamId: null, paperType: "focused", userId, assignedToId: userId },
              { paperType: "focused", assignedToId: { in: linkedStudentIds } },
              { paperType: "quiz", assignedToId: { in: linkedStudentIds } },
              { paperType: "diagnostic", assignedToId: { in: linkedStudentIds } },
              { paperType: "mastery", assignedToId: { in: linkedStudentIds } },
              // Also include regular paper clones assigned to linked students
              { sourceExamId: { not: null }, paperType: null, assignedToId: { in: linkedStudentIds } },
            ],
          };
        } else {
          // Non-admin parents see admin's master papers + own focused tests + student clones
          const adminUser = await prisma.user.findFirst({
            where: { name: { equals: "admin", mode: "insensitive" } },
            select: { id: true },
          });
          where = {
            OR: [
              {
                sourceExamId: null,
                paperType: null,
                visible: true,
                OR: levelConditions,
                ...(adminUser ? { userId: adminUser.id } : {}),
              },
              { sourceExamId: null, paperType: "focused", userId },
              { paperType: "focused", assignedToId: { in: linkedStudentIds } },
              { paperType: "quiz", assignedToId: { in: linkedStudentIds } },
              { paperType: "diagnostic", assignedToId: { in: linkedStudentIds } },
              { paperType: "mastery", assignedToId: { in: linkedStudentIds } },
              // Also include regular paper clones assigned to linked students
              { sourceExamId: { not: null }, paperType: null, assignedToId: { in: linkedStudentIds } },
            ],
          };
        }
      } else if (isAdminUser) {
        // Admin with no linked students — still show all master papers
        where = {
          sourceExamId: null,
          OR: [
            { paperType: null },
            { paperType: "focused", userId, assignedToId: null },
            { paperType: "focused", userId, assignedToId: userId },
          ],
        };
        // linkedStudentIds stays [] so clones include is filtered to none
      } else {
        // No linked students — show no papers
        where = { id: "none" };
      }
    }
  }

  // Auto-fail papers stuck in "processing" for more than 15 minutes (based on updatedAt)
  const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
  await prisma.examPaper.updateMany({
    where: {
      extractionStatus: "processing",
      updatedAt: { lt: staleThreshold },
    },
    data: { extractionStatus: "failed" },
  });

  // Chinese pathway gating: while the Chinese fork is being built, only
  // admin users see Chinese papers in any list view. Apply on top of
  // the role-based `where` rather than replacing it. (actorIsAdmin
  // was resolved up-front alongside `role` — see top of GET.)
  if (!actorIsAdmin) {
    // Chinese pathway: hide the MASTER Chinese papers from non-admins
    // (those are the library entries non-admins shouldn't browse / clone
    // from) but KEEP Chinese clones — when an admin assigns a Chinese
    // paper to a student, the resulting clone (sourceExamId != null) is
    // the student's actual quiz and must remain visible. Hiding it too
    // would mean the student opens the dashboard and the assignment is
    // gone. Quizzes / focused tests built from Chinese masters
    // (paperType="quiz" / "focused") are also clone-shaped under our
    // model — they all have a real master assignedToId — so the
    // sourceExamId guard alone leaks them through.
    const hideChineseMaster = {
      NOT: {
        AND: [
          { subject: { contains: "chinese", mode: "insensitive" as const } },
          { sourceExamId: null },
          { paperType: null },
        ],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where = where ? { AND: [where as any, hideChineseMaster] } : hideChineseMaster;
  }

  const papers = await prisma.examPaper.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { questions: true, clones: true } },
      assignedTo: { select: { id: true, name: true } },
    },
  });

  // Per-paper aggregates that used to live as N+1 sub-queries inside
  // the include block above:
  //   - clones (one fetch per master, plus a nested flagged-questions
  //     subquery per clone → 500+ round-trips on an admin dashboard)
  //   - per-paper "any tagged/extracted question" probe (one row pulled
  //     per paper, again N round-trips)
  // We don't actually need the individual rows — only the aggregates.
  // Replace the includes with a few groupBy / findMany calls that
  // bucket the results by paper id. Typical wins on a busy dashboard:
  //   admin /api/exam: ~2 s → ~300 ms
  //   parent /api/exam: ~1 s → ~200 ms
  const paperIds = papers.map((p) => p.id);

  // Student-only short-circuit. Students see their OWN assigned clones,
  // not masters — so all of the master-side aggregates below
  // (clones bucket, flagged groupBy, tagged/extracted probe) compute
  // values the student card never reads. Skipping them on student
  // requests drops /api/exam from ~6 queries to 3 + halves the polling
  // load (the student dashboard polls this every 30 s).
  const isStudent = role === "STUDENT";

  // Per-master aggregates derived from the clones table. Empty buckets
  // are fine — `.get() ?? 0/{}` covers the masters that have no clones.
  type CloneSummary = {
    id: string;
    markingStatus: string | null;
    assignedToId: string | null;
    createdAt: Date;
  };
  const clonesByMaster = new Map<string, CloneSummary[]>();
  const flaggedByMaster = new Map<string, number>();
  if (!isStudent && paperIds.length > 0) {
    const cloneRows = await prisma.examPaper.findMany({
      where: {
        sourceExamId: { in: paperIds },
        ...(linkedStudentIds !== null ? { assignedToId: { in: linkedStudentIds } } : {}),
      },
      select: {
        id: true, sourceExamId: true,
        markingStatus: true, assignedToId: true, createdAt: true,
      },
    });
    for (const c of cloneRows) {
      if (!c.sourceExamId) continue;
      const bucket = clonesByMaster.get(c.sourceExamId) ?? [];
      bucket.push(c);
      clonesByMaster.set(c.sourceExamId, bucket);
    }
    // Single aggregate over examQuestion: one row per clone that has
    // any flagged questions, with the count. Most clones have zero
    // and aren't returned. We then sum per master via clonesByMaster.
    const cloneIds = cloneRows.map((c) => c.id);
    if (cloneIds.length > 0) {
      const flaggedGroups = await prisma.examQuestion.groupBy({
        by: ["examPaperId"],
        where: { examPaperId: { in: cloneIds }, flagged: true },
        _count: { _all: true },
      });
      const flaggedByClone = new Map<string, number>();
      for (const g of flaggedGroups) flaggedByClone.set(g.examPaperId, g._count._all);
      for (const [masterId, clones] of clonesByMaster.entries()) {
        let total = 0;
        for (const c of clones) total += flaggedByClone.get(c.id) ?? 0;
        if (total > 0) flaggedByMaster.set(masterId, total);
      }
    }
  }

  // "Does this paper have ANY tagged or extracted question?" — single
  // groupBy returns the paper ids that match, then JS membership checks
  // derive the two booleans the response needs (syllabusTagged,
  // cleanExtracted). Old code pulled one row per paper.
  const hasTaggedPaperIds = new Set<string>();
  const hasExtractedPaperIds = new Set<string>();
  if (!isStudent && paperIds.length > 0) {
    const probe = await prisma.examQuestion.groupBy({
      by: ["examPaperId"],
      where: {
        examPaperId: { in: paperIds },
        OR: [{ syllabusTopic: { not: null } }, { transcribedStem: { not: null } }],
      },
      _count: { _all: true },
    });
    // groupBy on the OR can't separate which side matched; do a second
    // tiny groupBy filtered to transcribedStem so we can populate
    // cleanExtracted accurately. Anything in the first set that isn't
    // in this second set was matched only via syllabusTopic.
    const extracted = await prisma.examQuestion.groupBy({
      by: ["examPaperId"],
      where: {
        examPaperId: { in: paperIds },
        transcribedStem: { not: null },
      },
      _count: { _all: true },
    });
    for (const g of probe) hasTaggedPaperIds.add(g.examPaperId);
    for (const g of extracted) hasExtractedPaperIds.add(g.examPaperId);
  }

  // (Removed: per-paper metadata JSONB fetch.) Used to pull
  // metadata for every paper AND every source master to derive
  // isRevision (metadata.revisionMode) and hasNormalExtractEnglish
  // (metadata.normalExtractEnglish.*). Step (a) of the slow-load fix
  // dropped hasNormalExtractEnglish from the response (English print
  // is admin-only now, no per-paper flag needed). Step (b) added
  // ExamPaper.isRevision as a denormalised column updated by the
  // student-revision writer. The pull was the slowest query in this
  // endpoint (~2 s on a busy dashboard, pulling MB of OCR passage
  // text per row); reading the column saves all of that.

  // Skipped-marks lookup. The review page shows pct =
  // score / (totalMarks − skippedMarks) so a student isn't penalised
  // for questions they skipped — the homepage cards should match
  // that. One aggregate query for all completed papers in scope;
  // sum on the JS side.
  const completedPaperIds = papers.filter((p) => p.completedAt).map((p) => p.id);
  const skippedRows = completedPaperIds.length === 0 ? [] : await prisma.examQuestion.findMany({
    where: { examPaperId: { in: completedPaperIds }, studentAnswer: "__SKIPPED__" },
    select: { examPaperId: true, marksAvailable: true },
  });
  const skippedMarksById = new Map<string, number>();
  for (const r of skippedRows) {
    skippedMarksById.set(r.examPaperId, (skippedMarksById.get(r.examPaperId) ?? 0) + (r.marksAvailable ?? 0));
  }

  return NextResponse.json({
    papers: papers.map((p) => {
      // Pull this master's clones (if any) from the pre-bucketed Map and
      // derive every clone-dependent aggregate in one pass.
      const clones = clonesByMaster.get(p.id) ?? [];
      let unreleased = 0;
      let pendingReview = 0;
      const latestByStudent = new Map<string, Date>();
      for (const c of clones) {
        if (c.markingStatus !== "released") unreleased++;
        if (c.markingStatus === "complete") pendingReview++;
        if (c.assignedToId) {
          const cur = latestByStudent.get(c.assignedToId);
          if (!cur || c.createdAt > cur) latestByStudent.set(c.assignedToId, c.createdAt);
        }
      }
      return {
        id: p.id,
        title: p.title,
        school: p.school,
        level: p.level,
        subject: p.subject,
        questionCount: p._count.questions,
        createdAt: p.createdAt.toISOString(),
        scheduledFor: p.scheduledFor?.toISOString() ?? null,
        assignedToId: p.assignedToId,
        assignedToName: p.assignedTo?.name ?? null,
        completedAt: p.completedAt?.toISOString() ?? null,
        markingStatus: p.markingStatus ?? null,
        extractionStatus: p.extractionStatus ?? null,
        assignmentCount: p._count.clones,
        // Per-student last-assigned timestamp lookup. UI shows the entry for
        // the currently selected student so the parent sees 'Last assigned
        // 3 days ago' inline next to the Assign button.
        lastAssignedByStudent: Object.fromEntries(
          [...latestByStudent.entries()].map(([k, v]) => [k, v.toISOString()]),
        ),
        score: p.score ?? null,
        totalMarks: p.totalMarks ?? null,
        skippedMarks: skippedMarksById.get(p.id) ?? 0,
        paperType: p.paperType ?? null,
        examType: p.examType ?? null,
        printedAt: p.printedAt?.toISOString() ?? null,
        sourceExamId: p.sourceExamId ?? null,
        syllabusTagged: hasTaggedPaperIds.has(p.id),
        cleanExtracted: hasExtractedPaperIds.has(p.id),
        flaggedCount: flaggedByMaster.get(p.id) ?? 0,
        unreleasedAssignmentCount: unreleased,
        pendingReviewCount: pendingReview,
        instantFeedback: p.instantFeedback,
        visible: p.visible,
        timeSpentSeconds: p.timeSpentSeconds,
        isRevision: p.isRevision,
      };
    }),
  });
}
