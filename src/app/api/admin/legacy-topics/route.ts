// Admin-only API for reviewing + re-tagging legacy PSLE topics
// (Cells / Speed / Compass -- topics removed from the 2025/2026
// syllabus). The review panel at /admin/legacy-topics consumes
// these endpoints.
//
// GET  -> { Cells: Candidate[], Speed: Candidate[], Compass: Candidate[] }
//   Live-scans clean-extract MASTER questions whose stem matches
//   the legacy-topic regex AND whose syllabusTopic isn't already
//   one of the legacy topics AND that haven't been previously
//   "Skip"-marked. Detection lives in src/lib/legacy-topics.ts so
//   regex tuning is just a code edit + push.
//
// PATCH { questionId, decision: "approve" | "skip", topic: LegacyTopic }
//   approve -> set examQuestion.syllabusTopic = topic
//   skip    -> set examPaper.metadata.legacyTopicReviewed[questionId]
//              = topic, so the question no longer appears in the
//              candidate list (admin already decided "not this
//              topic" and we shouldn't keep asking).

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { LEGACY_TOPICS, LEGACY_TOPIC_DETECTOR, LEGACY_TOPIC_SUBJECT, questionTextBlob, type LegacyTopic } from "@/lib/legacy-topics";

type Candidate = {
  questionId: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  paperLevel: string | null;
  currentTopic: string | null;
  stemSnippet: string;
};

export async function GET() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const out: Record<LegacyTopic, Candidate[]> = { Cells: [], Speed: [], Compass: [] };

  for (const topic of LEGACY_TOPICS) {
    const subjectMatch = LEGACY_TOPIC_SUBJECT[topic];
    const regex = LEGACY_TOPIC_DETECTOR[topic];

    const masters = await prisma.examPaper.findMany({
      where: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: subjectMatch, mode: "insensitive" },
      },
      select: { id: true, title: true, level: true, metadata: true },
    });
    const paperById = new Map(masters.map(p => [p.id, p]));

    const rows = await prisma.examQuestion.findMany({
      where: {
        examPaperId: { in: masters.map(p => p.id) },
        // Exclude questions already tagged with any legacy topic --
        // those are the ones we already re-classified.
        syllabusTopic: { notIn: [...LEGACY_TOPICS] },
      },
      select: {
        id: true, questionNum: true, examPaperId: true, syllabusTopic: true,
        transcribedStem: true, transcribedOptions: true, transcribedSubparts: true, transcribedOptionTable: true,
      },
    });

    for (const q of rows) {
      const blob = questionTextBlob(q);
      if (!regex.test(blob)) continue;
      const paper = paperById.get(q.examPaperId);
      if (!paper) continue;
      // Skip questions the admin previously marked as "not this
      // legacy topic" via the Skip button. The skip list is keyed
      // by topic so the same question can show up under Cells but
      // be skipped under Compass.
      const skipped = (paper.metadata as { legacyTopicReviewed?: Record<string, string> } | null)?.legacyTopicReviewed?.[q.id];
      if (skipped === topic) continue;
      out[topic].push({
        questionId: q.id,
        questionNum: q.questionNum,
        paperId: paper.id,
        paperTitle: paper.title,
        paperLevel: paper.level,
        currentTopic: q.syllabusTopic,
        stemSnippet: (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 220),
      });
    }
  }

  return NextResponse.json({ candidates: out });
}

export async function PATCH(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { questionId?: unknown; decision?: unknown; topic?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const questionId = typeof body.questionId === "string" ? body.questionId : null;
  const decision = body.decision === "approve" || body.decision === "skip" ? body.decision : null;
  const topic = typeof body.topic === "string" && (LEGACY_TOPICS as readonly string[]).includes(body.topic) ? body.topic as LegacyTopic : null;
  if (!questionId || !decision || !topic) {
    return NextResponse.json({ error: "questionId, decision (approve|skip), topic (Cells|Speed|Compass) required" }, { status: 400 });
  }

  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: { id: true, examPaperId: true, syllabusTopic: true },
  });
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  if (decision === "approve") {
    // Re-tag the question. After this, the GET endpoint excludes it
    // from candidates (notIn LEGACY_TOPICS), AND the daily-quiz +
    // focused-test routes exclude it from their pools. Full-paper
    // assignments still see it.
    await prisma.examQuestion.update({
      where: { id: questionId },
      data: { syllabusTopic: topic },
    });
    return NextResponse.json({ ok: true, action: "tagged", oldTopic: q.syllabusTopic, newTopic: topic });
  }

  // Skip: record on the paper's metadata.legacyTopicReviewed map so
  // this question stops showing up in the candidate list for this
  // topic. It STAYS in candidates for the other two topics if its
  // stem matches both (regex is per-topic, intentional).
  const paper = await prisma.examPaper.findUnique({
    where: { id: q.examPaperId },
    select: { metadata: true },
  });
  const meta = (paper?.metadata as Record<string, unknown> | null) ?? {};
  const reviewed = (meta.legacyTopicReviewed as Record<string, string> | undefined) ?? {};
  reviewed[questionId] = topic;
  await prisma.examPaper.update({
    where: { id: q.examPaperId },
    data: { metadata: { ...meta, legacyTopicReviewed: reviewed } as Prisma.InputJsonValue },
  });
  return NextResponse.json({ ok: true, action: "skipped", topic });
}
