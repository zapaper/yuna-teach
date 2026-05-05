import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";
import { fetchMistakeQuestions, orderMistakesForRevision, fetchPassageCompanions, type SubjectKey } from "@/lib/revision";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

function isMcqByContent(opts: unknown, optImgs: unknown, answer: string | null): boolean {
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(optImgs) && optImgs.some((o) => !!o)) return true;
  const a = (answer ?? "").trim().replace(/[().]/g, "");
  return a === "1" || a === "2" || a === "3" || a === "4";
}

// POST /api/admin/student-revision
//
// Body: { studentId, subject: 'math'|'science'|'english', count: number, mode: 'review'|'practice' }
//
// Compiles a new ExamPaper out of the student's recent mistakes for
// the given subject:
//   review   → marked paper. completedAt set, marksAwarded /
//              studentAnswer / markingNotes preserved, redirects
//              parent to /exam/<id>/review
//   practice → blank paper. No marks, no studentAnswer. Redirects
//              parent to /exam/<id> so the student can do it.
// Both use paperType="quiz" so the dashboard cards / quiz player
// flows already work.

const SUBJECT_LABEL: Record<SubjectKey, string> = {
  math: "Math",
  science: "Science",
  english: "English",
};
const SUBJECT_FULL: Record<SubjectKey, string> = {
  math: "Mathematics",
  science: "Science",
  english: "English Language",
};

export async function POST(request: NextRequest) {
  const callerId = await getSessionUserId();
  if (!callerId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { studentId?: string; subject?: SubjectKey; count?: number; mode?: "review" | "practice" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }
  const { studentId, subject, count, mode } = body;
  if (!studentId || !subject || !count || !mode) {
    return NextResponse.json({ error: "studentId, subject, count, mode required" }, { status: 400 });
  }

  // Authorisation: admin, the student themselves, or a linked
  // parent. Anyone else gets a 403 so a student id can't be
  // passed by an unrelated user to mine someone else's mistakes.
  const callerIsAdmin = await isSessionAdmin();
  if (!callerIsAdmin && callerId !== studentId) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: callerId, studentId } },
      select: { id: true },
    });
    if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (subject !== "math" && subject !== "science" && subject !== "english") {
    return NextResponse.json({ error: "invalid subject" }, { status: 400 });
  }
  if (mode !== "review" && mode !== "practice") {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return NextResponse.json({ error: "count out of range" }, { status: 400 });
  }

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, name: true, level: true, role: true },
  });
  if (!student || student.role !== "STUDENT") {
    return NextResponse.json({ error: "student not found" }, { status: 404 });
  }

  // Pull a generous candidate set so the ordering pass has room to
  // place comp-OEQ at the end / MCQs first without truncating
  // arbitrarily. We then trim to `count`.
  const mistakes = await fetchMistakeQuestions(studentId, subject, Math.max(count * 3, 60));
  if (mistakes.length === 0) {
    return NextResponse.json({ error: "no mistakes found for this subject" }, { status: 404 });
  }
  // Pick the N mistakes the parent asked for, then (English review
  // only) pad each implicated passage section with the
  // right-answered companions so the cloze renderer fills every
  // blank — wrong ones in red, companions in green using the
  // student's own correct answer. Companions don't count against
  // the slider. Practice mode skips this — it should give the
  // student a clean re-attempt of just the mistakes, not a
  // mixture they've already aced.
  const chosen = orderMistakesForRevision(subject, mistakes).slice(0, count);
  const companions = (subject === "english" && mode === "review")
    ? await fetchPassageCompanions(chosen)
    : [];
  // Re-order so each section group stays contiguous and sorted by
  // source orderIndex (mistakes + companions interleaved in passage
  // order, which is what the renderer expects).
  const ordered = orderMistakesForRevision(subject, [...chosen, ...companions]);

  // Practice mode: prefer the master question's CURRENT answer key
  // (and answer image) over the clone's stored copy — admins
  // sometimes fix master answer keys after a clone has been
  // generated, and a practice attempt should be graded against the
  // up-to-date key. Falls back to clone's answer when the master
  // has been deleted or its answer field is empty. Review mode
  // keeps the clone's answer because its grading already happened
  // against that key — re-rendering with a different one would
  // make the marking notes contradict the displayed answer.
  const masterAnswerById = new Map<string, { answer: string | null; answerImageData: string | null }>();
  if (mode === "practice") {
    const sourceIds = [...new Set(ordered.map((m) => m.sourceQuestionId))];
    const masters = await prisma.examQuestion.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, answer: true, answerImageData: true },
    });
    for (const mq of masters) {
      masterAnswerById.set(mq.id, { answer: mq.answer, answerImageData: mq.answerImageData });
    }
  }

  // Each MistakeQuestion already carries the clone's full content
  // (transcribedStem etc.) — that's what the student actually saw,
  // and pulling from the clone preserves any clean-extract that was
  // run after the master was first uploaded. Source content might
  // even be different from what the student saw, so we always
  // prefer clone content for everything except the answer key (see
  // above).
  type QuestionCreate = Prisma.ExamQuestionCreateWithoutExamPaperInput;
  const questionCreates: QuestionCreate[] = [];
  let i = 0;
  for (const m of ordered) {
    const isReview = mode === "review";
    const master = masterAnswerById.get(m.sourceQuestionId);
    // Pull master's answer if it has one (truthy), else fall back
    // to clone's. Empty-string master answers fall through to
    // clone too — an empty master key is effectively no key.
    const useMasterAnswer = !isReview && master && (master.answer || master.answerImageData);
    questionCreates.push({
      questionNum: String(i + 1),
      imageData: m.imageData ?? "",
      answer: useMasterAnswer ? (master.answer ?? m.answer) : m.answer,
      answerImageData: useMasterAnswer ? (master.answerImageData ?? m.answerImageData) : m.answerImageData,
      pageIndex: 0,
      orderIndex: i,
      marksAvailable: m.marksAvailable,
      syllabusTopic: m.syllabusTopic,
      transcribedStem: m.transcribedStem,
      transcribedOptions: (m.transcribedOptions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      transcribedOptionImages: (m.transcribedOptionImages ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      transcribedSubparts: (m.transcribedSubparts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      diagramImageData: m.diagramImageData,
      diagramBounds: (m.diagramBounds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      // sourceQuestionId points at the master so future re-marking /
      // cross-paper analytics still trace back correctly.
      sourceQuestionId: m.sourceQuestionId,
      // Review mode: re-attach the student's prior marking artefacts
      // so the review page renders exactly what the parent saw at
      // grading time.
      ...(isReview ? {
        marksAwarded: m.marksAwarded,
        studentAnswer: m.studentAnswer,
        markingNotes: m.markingNotes,
      } : {}),
    });
    i++;
  }
  if (questionCreates.length === 0) {
    return NextResponse.json({ error: "no source questions resolved" }, { status: 404 });
  }

  const totalMarks = questionCreates.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0);
  const dateLabel = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const levelLabel = student.level ? `P${student.level} ` : "";
  const title = `${levelLabel}${SUBJECT_LABEL[subject]} Revision ${dateLabel}`;

  // For English revision papers, reconstruct englishSections in
  // metadata so the review UI shows the cloze passage above its
  // blanks (and Comp-OEQ above its prompts). One section per
  // distinct source-section key in the ordered question list, with
  // start/end indices into the new question list.
  type SectionMeta = { label: string; startIndex: number; endIndex: number; passage?: string };
  const englishSectionsMeta: SectionMeta[] = [];
  if (subject === "english") {
    let curKey: string | undefined;
    let curSection: SectionMeta | undefined;
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      const key = m.sourceSectionKey;
      // Skip questions with no source-section info — they'll just
      // render without a passage, which is fine for non-cloze
      // English types.
      if (!key || !m.englishSection) {
        if (curSection) {
          englishSectionsMeta.push(curSection);
          curSection = undefined;
          curKey = undefined;
        }
        continue;
      }
      if (key !== curKey) {
        if (curSection) englishSectionsMeta.push(curSection);
        curKey = key;
        curSection = {
          label: m.englishSection.label,
          startIndex: i,
          endIndex: i,
          ...(m.englishSection.passage ? { passage: m.englishSection.passage } : {}),
        };
      } else {
        curSection!.endIndex = i;
      }
    }
    if (curSection) englishSectionsMeta.push(curSection);
  }

  const paper = await prisma.examPaper.create({
    data: {
      title,
      subject: SUBJECT_FULL[subject],
      level: student.level ? `Primary ${student.level}` : null,
      userId: callerId,
      assignedToId: studentId,
      paperType: "quiz",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(totalMarks),
      // Review mode: paper is already 'completed' with all marking
      // baked in. Practice: blank paper waiting for the student.
      ...(mode === "review"
        ? { completedAt: new Date(), markingStatus: "complete" }
        : {}),
      metadata: {
        revisionMode: mode,
        revisionSubject: subject,
        compiledAt: new Date().toISOString(),
        compiledBy: callerId,
        ...(englishSectionsMeta.length > 0 ? { englishSections: englishSectionsMeta } : {}),
      },
      questions: { create: questionCreates },
    },
    select: { id: true },
  });

  // Deliberately leave paper.score null even for review mode. The
  // revision paper is a compilation of mistakes — showing "0%" or a
  // very low score on the dashboard makes it look like the student
  // scored badly on a fresh quiz, when it's actually a curated set
  // of past errors. scorePct() returns null when score is null and
  // the card just hides the percentage chip.

  // ── OEQ canvas image carry-over ─────────────────────────────────
  // The review page reads the student's handwritten canvas from
  // submissions/<paperId>/page_<oeqIdx>.jpg (and per-subpart files).
  // Without copies under the new revision paper's directory the
  // review just shows blank canvases. For each OEQ mistake question
  // we (a) compute its position among OEQs in the new paper, (b)
  // look up the source clone's oeqPageMap to find where the
  // original images live, (c) copy the JPEG / ink-PNG / per-subpart
  // files across, and (d) record the mapping on the new paper's
  // metadata.oeqPageMap so the review page can find them again.
  if (mode === "review") {
    try {
      // Pull the new questions back so we have stable IDs paired up
      // with their orderIndex (which matches `ordered`'s order).
      const newQuestions = await prisma.examQuestion.findMany({
        where: { examPaperId: paper.id },
        orderBy: { orderIndex: "asc" },
        select: { id: true, transcribedOptions: true, transcribedOptionImages: true, answer: true, transcribedSubparts: true },
      });
      // Source clone metadata for oeqPageMap lookups, batched.
      const cloneIds = [...new Set(ordered.map((m) => m.cloneExamPaperId))];
      const clones = await prisma.examPaper.findMany({
        where: { id: { in: cloneIds } },
        select: { id: true, metadata: true },
      });
      const cloneOeqMapById = new Map<string, Record<string, number> | null>();
      for (const c of clones) {
        const m = (c.metadata as { oeqPageMap?: Record<string, number> } | null) ?? null;
        cloneOeqMapById.set(c.id, m?.oeqPageMap ?? null);
      }

      const newSubDir = path.join(SUBMISSIONS_DIR, paper.id);
      await fs.mkdir(newSubDir, { recursive: true });
      const newOeqPageMap: Record<string, number> = {};
      let newOeqIdx = 0;

      for (let idx = 0; idx < ordered.length && idx < newQuestions.length; idx++) {
        const m = ordered[idx];
        const newQ = newQuestions[idx];
        const isMcq = isMcqByContent(newQ.transcribedOptions, newQ.transcribedOptionImages, newQ.answer);
        if (isMcq) continue; // OEQ only — MCQs have no canvas

        const srcOeqMap = cloneOeqMapById.get(m.cloneExamPaperId);
        const srcOeqIdx = srcOeqMap?.[m.cloneQuestionId];
        if (srcOeqIdx == null) {
          // Old clone might pre-date oeqPageMap. Skip — review will
          // just show no canvas for this question, same as the
          // original quiz's behaviour for that paper.
          newOeqIdx++;
          continue;
        }

        newOeqPageMap[newQ.id] = newOeqIdx;
        const srcDir = path.join(SUBMISSIONS_DIR, m.cloneExamPaperId);

        // Files to copy: composite JPEG + ink PNG + per-subpart copies.
        const filenames: string[] = [
          `page_${srcOeqIdx}.jpg`,
          `page_${srcOeqIdx}_ink.png`,
        ];
        const subs = (newQ.transcribedSubparts as { label: string }[] | null) ?? [];
        for (const sp of subs) {
          if (sp.label.startsWith("_")) continue;
          filenames.push(`page_${srcOeqIdx}_${sp.label}.jpg`);
          filenames.push(`page_${srcOeqIdx}_${sp.label}_ink.png`);
        }

        for (const fname of filenames) {
          const srcPath = path.join(srcDir, fname);
          const dstName = fname.replace(`page_${srcOeqIdx}`, `page_${newOeqIdx}`);
          const dstPath = path.join(newSubDir, dstName);
          try {
            await fs.copyFile(srcPath, dstPath);
          } catch {
            // Per-subpart files may not exist if the student left
            // that subpart blank. Composite + ink should usually
            // exist; their absence is non-fatal too.
          }
        }
        newOeqIdx++;
      }

      if (Object.keys(newOeqPageMap).length > 0) {
        // Merge into the existing metadata so we don't clobber
        // revisionMode / compiledAt / englishSections / etc. The
        // create above already wrote englishSections for English
        // papers; this update preserves it by re-applying the
        // same value rather than re-deriving.
        await prisma.examPaper.update({
          where: { id: paper.id },
          data: {
            metadata: {
              revisionMode: mode,
              revisionSubject: subject,
              compiledAt: new Date().toISOString(),
              compiledBy: callerId,
              oeqPageMap: newOeqPageMap,
              ...(englishSectionsMeta.length > 0 ? { englishSections: englishSectionsMeta } : {}),
            },
          },
        });
      }
    } catch (err) {
      console.warn(`[student-revision] OEQ carry-over failed for ${paper.id}:`, err);
    }
  }

  // Both modes are paperType='quiz', so the practice flow goes to
  // the quiz player (/quiz/[id]) — the /exam/[id] route is the
  // printable-paper PDF viewer and doesn't know how to render quiz
  // content (which is why earlier compile-and-set-paper output
  // looked like raw stems — the exam viewer falls back to imageData
  // even when the question carries a clean transcribedStem).
  //
  // ?userId=<callerId> is required by the review page's back-link
  // logic — without it backPath computes to /home/null?... and the
  // back button errors. The compiler is always the admin, so we use
  // callerId here.
  const redirectUrl = mode === "review"
    ? `/exam/${paper.id}/review?userId=${callerId}`
    : `/quiz/${paper.id}?userId=${callerId}`;

  return NextResponse.json({
    paperId: paper.id,
    title,
    questionCount: questionCreates.length,
    redirectUrl,
  });
}
