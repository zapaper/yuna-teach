import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/admin/parent-progress
//
// Returns one row per parent for the Beta Mailing List "rich CSV" export:
//   parent name + email, plus up to 2 linked children. For each child:
//     - weakness topic (lowest avg pct across completed-paper questions
//       with at least 3 attempts)
//     - avg score % over papers completed in the last 7 days
//     - last 3 completed quiz/paper titles + score %
//
// Admin only. Heavy aggregation runs in JS — 200ish parents × few
// students × handful of papers is well within budget for a one-shot
// admin export.

export const maxDuration = 120;

type ChildSummary = {
  name: string;
  homepageUrl: string;
  weaknessTopic: string | null;
  avg7dPct: number | null;
  recent: Array<{ title: string; pct: number | null }>;
};

type ParentRow = {
  parentName: string;
  parentEmail: string;
  parentHomepageUrl: string;
  // Total quizzes "set" — parent-assigned + each linked student's
  // self-assigned/uploaded papers (matches the paperCount shown on
  // /admin/users so the two views agree).
  quizzesSet: number;
  // Total papers across linked students with completedAt != null.
  quizzesCompleted: number;
  children: ChildSummary[];
};

export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Build absolute homepage URLs from the request origin. Forwarded
  // headers come from Vercel's proxy in production; local dev uses
  // request.nextUrl.origin as a fallback.
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const origin = host ? `${proto}://${host}` : request.nextUrl.origin;
  const homepageUrl = (id: string) => `${origin}/home/${id}`;

  const parents = await prisma.user.findMany({
    where: { role: "PARENT", email: { not: null } },
    select: {
      id: true,
      name: true,
      displayName: true,
      email: true,
      _count: { select: { examPapers: true } },
      parentLinks: {
        select: {
          student: {
            select: {
              id: true,
              name: true,
              displayName: true,
              _count: { select: { examPapers: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows: ParentRow[] = [];

  for (const p of parents) {
    const children: ChildSummary[] = [];
    // Total "set" = parent's own examPapers + each linked student's
    // self-assigned/uploaded papers. Matches the paperCount on
    // /admin/users.
    const quizzesSet =
      p._count.examPapers +
      p.parentLinks.reduce((sum, l) => sum + l.student._count.examPapers, 0);
    let quizzesCompleted = 0;

    for (const link of p.parentLinks) {
      const studentId = link.student.id;
      const studentName =
        link.student.displayName?.trim() || link.student.name || "—";

      // All completed papers assigned to this student.
      const papers = await prisma.examPaper.findMany({
        where: {
          assignedToId: studentId,
          completedAt: { not: null },
          // Skip papers still being marked — score / questions data
          // would be misleading.
          markingStatus: { in: ["complete", "released"] },
        },
        orderBy: { completedAt: "desc" },
        select: {
          id: true,
          title: true,
          completedAt: true,
          questions: {
            select: {
              syllabusTopic: true,
              marksAwarded: true,
              marksAvailable: true,
            },
          },
        },
      });

      // Per-paper aggregate score (sum awarded / sum available).
      const paperScores = papers.map((paper) => {
        let awarded = 0;
        let available = 0;
        for (const q of paper.questions) {
          if (q.marksAvailable == null) continue;
          available += q.marksAvailable;
          awarded += q.marksAwarded ?? 0;
        }
        const pct =
          available > 0 ? Math.round((awarded / available) * 100) : null;
        return {
          title: paper.title,
          completedAt: paper.completedAt!,
          awarded,
          available,
          pct,
        };
      });

      // 7-day rolling average across all marks (weighted by marks
      // available, not by paper). Reflects effort / volume, not just
      // paper count.
      let recentAwarded = 0;
      let recentAvailable = 0;
      for (const paper of paperScores) {
        if (paper.completedAt < sevenDaysAgo) continue;
        recentAwarded += paper.awarded;
        recentAvailable += paper.available;
      }
      const avg7dPct =
        recentAvailable > 0
          ? Math.round((recentAwarded / recentAvailable) * 100)
          : null;

      // Weakness topic: across ALL completed papers, group by
      // syllabusTopic. Require ≥ 3 marks-available to qualify so a
      // single bad question doesn't dominate. Pick the topic with
      // the lowest avg pct.
      const topicTotals = new Map<
        string,
        { awarded: number; available: number; attempts: number }
      >();
      for (const paper of papers) {
        for (const q of paper.questions) {
          const topic = q.syllabusTopic?.trim();
          if (!topic) continue;
          if (q.marksAvailable == null) continue;
          const t = topicTotals.get(topic) ?? {
            awarded: 0,
            available: 0,
            attempts: 0,
          };
          t.awarded += q.marksAwarded ?? 0;
          t.available += q.marksAvailable;
          t.attempts += 1;
          topicTotals.set(topic, t);
        }
      }
      let weaknessTopic: string | null = null;
      let weaknessPct = Infinity;
      for (const [topic, t] of topicTotals) {
        if (t.attempts < 3) continue;
        if (t.available <= 0) continue;
        const pct = (t.awarded / t.available) * 100;
        if (pct < weaknessPct) {
          weaknessPct = pct;
          weaknessTopic = topic;
        }
      }

      // Last 3 completed paper titles + scores.
      const recent = paperScores.slice(0, 3).map((p) => ({
        title: p.title,
        pct: p.pct,
      }));

      // Each completed paper for this student counts toward the
      // "quizzes all students completed" total.
      quizzesCompleted += papers.length;

      children.push({
        name: studentName,
        homepageUrl: homepageUrl(studentId),
        weaknessTopic,
        avg7dPct,
        recent,
      });
    }

    rows.push({
      parentName: p.displayName?.trim() || p.name,
      parentEmail: p.email!,
      parentHomepageUrl: homepageUrl(p.id),
      quizzesSet,
      quizzesCompleted,
      children,
    });
  }

  return NextResponse.json({ rows });
}
