// Weekly delta computation — diff between last week's diagnosis cache
// and the current cache, augmented with evidence checks against this
// week's actual papers. Powers the "Lumi's update this week" block at
// the top of the Lumi page (src/app/tutor/[parentId]/page.tsx).
//
// Inputs: prior cache + current cache + studentId + subject.
// Output: WeeklyDelta object the page renders.
//
// Lives next to tutor.ts so the Lumi page can call this from its
// server-side loadTutorData path without crossing module boundaries.

import { prisma } from "@/lib/db";

type Pattern = {
  name: string;
  what?: string;
  strategic_advice?: string;
  trigger_keywords?: string[];
  specific_examples?: Array<{ questionRef?: string; whatWentWrong?: string }>;
};

type CacheLike = {
  patterns?: Pattern[];
  generatedAt?: string;
};

export type WeeklyDelta = {
  prevGeneratedAt: string;
  currGeneratedAt: string;
  papersThisWeek: number;
  questionsThisWeek: number;
  caseA: boolean;
  prefaceText: string;
  wins: Array<{
    patternName: string;
    patternWhat?: string;
    patternAdvice?: string;
    exampleHit: {
      paperTitle: string;
      questionNum: string;
      topic: string | null;
      aw: number;
      av: number;
      stem: string;
      studentAnswer: string | null;
    };
  }>;
  topicProgress: Array<{
    topic: string;
    thisPct: number;
    prevPct: number;
    delta: number;
    attemptsThisWeek: number;
  }>;
  newMistakes: Array<{
    patternName: string;
    patternWhat?: string;
    patternAdvice?: string;
    // A specific question from THIS WEEK where the kid hit this
    // mistake. Picked by matching the pattern's trigger keywords /
    // topic against this week's wrong-record questions, then taking
    // the highest-marksLost match. Lets the email show "here's the
    // exact place it surfaced" instead of an abstract description.
    exampleWrong?: {
      paperTitle: string;
      questionNum: string;
      topic: string | null;
      aw: number;
      av: number;
      stem: string;
      studentAnswer: string | null;
      markingNotes: string | null;
    };
  }>;
  notRetested: Array<{ patternName: string }>;
  // For the LumiQuizCombosCard deprioritisation: pattern names the kid
  // demonstrably retested this week (whether they passed or failed).
  // The combo card uses this to push down combos that map to these
  // patterns and surface fresh weakness instead.
  patternsRetested: string[];
};

type Subject = "math" | "science" | "english";

function normName(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function subjectKey(subject: string): Subject | null {
  const s = subject.toLowerCase();
  if (s.includes("math"))    return "math";
  if (s.includes("science")) return "science";
  if (s.includes("english")) return "english";
  return null;
}

function diffPatterns(prev: Pattern[], curr: Pattern[]): {
  carryOver: Pattern[]; cleared: Pattern[]; newOnes: Pattern[];
} {
  const prevByKey = new Map(prev.map(p => [normName(p.name), p] as const));
  const currByKey = new Map(curr.map(p => [normName(p.name), p] as const));
  const carryOver: Pattern[] = [];
  const cleared:   Pattern[] = [];
  const newOnes:   Pattern[] = [];
  for (const [k, p] of currByKey) {
    if (prevByKey.has(k)) carryOver.push(p);
    else                  newOnes.push(p);
  }
  for (const [k, p] of prevByKey) {
    if (!currByKey.has(k)) cleared.push(p);
  }
  return { carryOver, cleared, newOnes };
}

function subjectTopicMatchers(subj: Subject, pattern: Pattern): { topic: RegExp[]; sub: RegExp[]; skill: RegExp[] } {
  const n = pattern.name.toLowerCase();
  if (subj === "science") {
    const topic: RegExp[] = [];
    const sub: RegExp[]   = [];
    if (/heart|lung|respirat|circulat|breath/.test(n)) {
      topic.push(/respiratory/i, /circulatory/i);
      sub.push(/respiratory/i, /circulatory/i, /heart/i, /lung/i);
    }
    if (/electric/.test(n))  topic.push(/electric/i);
    if (/magnet/.test(n))  { topic.push(/magnet/i); sub.push(/magnet/i); }
    if (/heat/.test(n))    { topic.push(/heat/i); sub.push(/heat/i); }
    if (/light/.test(n))     topic.push(/light/i);
    if (/water|cycle/.test(n)) { topic.push(/water/i); sub.push(/cycle/i); }
    return { topic, sub, skill: [] };
  }
  if (subj === "math") {
    const topic: RegExp[] = [];
    if (/ratio/.test(n))                  topic.push(/ratio/i);
    if (/fraction/.test(n))               topic.push(/fraction/i);
    if (/percent/.test(n))                topic.push(/percent/i);
    if (/area|perimeter|circle/.test(n))  topic.push(/area/i, /perimeter/i, /circle/i, /geometry/i);
    if (/speed|distance|time/.test(n))    topic.push(/speed/i);
    return { topic, sub: [], skill: [] };
  }
  return { topic: [], sub: [], skill: [] };
}

function patternKeywordRegex(pattern: Pattern): RegExp | null {
  const kws: string[] = [];
  if (pattern.trigger_keywords?.length) {
    for (const t of pattern.trigger_keywords) if (typeof t === "string" && t.length >= 3) kws.push(t.toLowerCase());
  }
  for (const w of pattern.name.toLowerCase().split(/[^a-z]+/)) {
    if (w.length >= 4 && !["with", "this", "that", "they", "from"].includes(w)) kws.push(w);
  }
  if (kws.length === 0) return null;
  const escaped = kws.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
}

type WeekQuestion = {
  paperTitle: string;
  questionNum: string;
  stem: string;
  studentAnswer: string | null;
  marksAwarded: number;
  marksAvailable: number;
  markingNotes: string | null;
  syllabusTopic: string | null;
  subTopic: string | null;
  skillTags: string[];
};

type Evidence = {
  status: "real-win" | "still-failing" | "not-retested";
  totalSeen: number;
  full: number;
  partial: number;
  zero: number;
  exampleHit?: WeekQuestion;
};

function evidenceForCleared(pattern: Pattern, weekQuestions: WeekQuestion[], subj: Subject): Evidence {
  const matchers = subjectTopicMatchers(subj, pattern);
  const kwRe = patternKeywordRegex(pattern);
  const matches: WeekQuestion[] = [];
  for (const q of weekQuestions) {
    const t = q.syllabusTopic ?? ""; const s = q.subTopic ?? "";
    const tags = q.skillTags ?? [];
    const haystack = [q.stem, q.markingNotes, q.studentAnswer].filter(Boolean).join(" ");
    const topicHit = matchers.topic.some(r => r.test(t));
    const subHit   = matchers.sub.some(r => r.test(s));
    const skillHit = matchers.skill.length > 0 && tags.some(s => matchers.skill.some(r => r.test(s)));
    const kwHit    = kwRe ? kwRe.test(haystack) : false;
    if (topicHit || subHit || skillHit || kwHit) matches.push(q);
  }
  if (matches.length === 0) return { status: "not-retested", totalSeen: 0, full: 0, partial: 0, zero: 0 };
  let full = 0, partial = 0, zero = 0;
  let bestHit: WeekQuestion | null = null;
  for (const q of matches) {
    const av = q.marksAvailable, aw = q.marksAwarded;
    if (av === 0) continue;
    if (aw >= av) { full++; if (!bestHit || (aw - bestHit.marksAwarded) > 0) bestHit = q; }
    else if (aw > 0) partial++;
    else zero++;
  }
  const totalSeen = full + partial + zero;
  const winRatio = totalSeen > 0 ? full / totalSeen : 0;
  const status: Evidence["status"] = (totalSeen >= 1 && winRatio >= 0.7) ? "real-win" : "still-failing";
  return { status, totalSeen, full, partial, zero, exampleHit: bestHit ?? undefined };
}

// Topics-stats helper. Computes per-topic awarded/available/attempts
// either UP TO cutoff (last week's average) or FROM cutoff (this week's).
// Dedupes by sourceQuestionId — focused-practice clones reuse the same
// source questions, and counting both source + clone (or multiple clones
// of the same master) was inflating David's Human Respiratory count
// from 30 unique questions to 231. Also drops paperType="eval" rows —
// those are synthetic eval clones from marking-pipeline regressions,
// not real student practice.
async function topicStatsUpTo(kidId: string, subject: string, cutoff: Date): Promise<Map<string, { awarded: number; available: number; attempts: number }>> {
  const subj = subjectKey(subject);
  const where = {
    assignedToId: kidId,
    markingStatus: { in: ["complete", "released"] },
    subject: { contains: subj === "math" ? "math" : (subj ?? subject), mode: "insensitive" as const },
    completedAt: { lt: cutoff },
    NOT: { paperType: "eval" },
  };
  const papers = await prisma.examPaper.findMany({
    where,
    select: { metadata: true, questions: { select: { id: true, marksAwarded: true, marksAvailable: true, syllabusTopic: true, sourceQuestionId: true, studentAnswer: true } } },
  });
  const nonRev = papers.filter(p => !(p.metadata as { revisionMode?: unknown } | null)?.revisionMode);
  const m = new Map<string, { awarded: number; available: number; attempts: number }>();
  const seen = new Set<string>();
  for (const p of nonRev) {
    for (const q of p.questions) {
      if (q.studentAnswer === "__SKIPPED__") continue;
      const av = q.marksAvailable ?? 0; if (av === 0) continue;
      const t = (q.syllabusTopic ?? "").trim(); if (!t) continue;
      // Dedup by source — a clone shares its master's content, so
      // counting both pads the denominator without adding new signal.
      const key = q.sourceQuestionId ?? q.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = m.get(t) ?? { awarded: 0, available: 0, attempts: 0 };
      cur.awarded += q.marksAwarded ?? 0; cur.available += av; cur.attempts += 1;
      m.set(t, cur);
    }
  }
  return m;
}

export async function computeWeeklyDelta(
  studentId: string,
  subject: string,
  childFirst: string,
  prev: CacheLike | null,
  curr: CacheLike,
): Promise<WeeklyDelta | null> {
  const subj = subjectKey(subject);
  if (!subj) return null;
  if (!prev || !prev.generatedAt) return null;

  const prevPatterns = prev.patterns ?? [];
  const currPatterns = curr.patterns ?? [];
  const { carryOver, cleared, newOnes } = diffPatterns(prevPatterns, currPatterns);
  const cutoff = new Date(prev.generatedAt);

  // Pull papers + questions completed since the prior cache. Excludes
  // paperType="eval" — those are synthetic clones used by the marking
  // pipeline regression eval, not real student practice. They live
  // against the student's userId but mustn't appear in their progress.
  const newPapers = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      completedAt: { gt: cutoff },
      subject: { contains: subj === "math" ? "math" : subj, mode: "insensitive" },
      NOT: { paperType: "eval" },
    },
    select: {
      id: true, title: true, completedAt: true, score: true, paperType: true,
      questions: {
        select: {
          id: true, sourceQuestionId: true,
          questionNum: true, transcribedStem: true, studentAnswer: true,
          marksAwarded: true, marksAvailable: true, markingNotes: true,
          syllabusTopic: true, subTopic: true, skillTags: true,
        },
      },
    },
    orderBy: { completedAt: "asc" },
  });
  // Dedup by source — focused-practice clones share their master's
  // questions; counting both would double-count for evidence-of-
  // retest and topic-progress aggregates. The FIRST occurrence wins
  // (papers are sorted ascending, so we keep the earliest attempt).
  // Also drop __SKIPPED__ rows — those are kid-marked "I didn't try
  // this" sentinels, not real wrong answers. Including them lets the
  // delta pick a skipped question as a "new mistake" example
  // ("Kaiyang lost 2 marks on Q5") which is misleading: he didn't
  // attempt it, so Lumi has nothing to diagnose.
  const weekQuestions: WeekQuestion[] = [];
  const seenWeek = new Set<string>();
  for (const p of newPapers) {
    for (const q of p.questions) {
      if (q.studentAnswer === "__SKIPPED__") continue;
      const key = q.sourceQuestionId ?? q.id;
      if (seenWeek.has(key)) continue;
      seenWeek.add(key);
      weekQuestions.push({
        paperTitle: p.title,
        questionNum: q.questionNum,
        stem: q.transcribedStem ?? "",
        studentAnswer: q.studentAnswer,
        marksAwarded: q.marksAwarded ?? 0,
        marksAvailable: q.marksAvailable ?? 0,
        markingNotes: q.markingNotes,
        syllabusTopic: q.syllabusTopic,
        subTopic: q.subTopic,
        skillTags: q.skillTags ?? [],
      });
    }
  }

  // Skip the entire delta block when the kid hasn't done any new
  // work since the cache. Without new papers there are no wins, no
  // topic progress, no new mistakes to surface — just a "hasn't had
  // a chance" line that adds noise. Let the parent see the standing
  // Lumi summary unchanged.
  if (newPapers.length === 0) return null;
  const caseA = false; // (always false now — kept for type stability downstream)
  const prefaceText = `Great to see ${childFirst} putting in the work — ${newPapers.length} paper${newPapers.length === 1 ? "" : "s"} since last week. Here's what that practice has shifted, and where we can keep building.`;

  // Reclassify cleared patterns based on evidence.
  const wins: WeeklyDelta["wins"] = [];
  const stillFailingNames: string[] = [];
  const notRetested: WeeklyDelta["notRetested"] = [];
  const patternsRetested = new Set<string>();
  for (const p of cleared) {
    const ev = evidenceForCleared(p, weekQuestions, subj);
    if (ev.status === "real-win" && ev.exampleHit) {
      const ex = ev.exampleHit;
      wins.push({
        patternName: p.name,
        patternWhat: p.what,
        patternAdvice: p.strategic_advice,
        exampleHit: {
          paperTitle: ex.paperTitle, questionNum: ex.questionNum,
          topic: ex.syllabusTopic, aw: ex.marksAwarded, av: ex.marksAvailable,
          stem: ex.stem, studentAnswer: ex.studentAnswer,
        },
      });
      patternsRetested.add(p.name);
    } else if (ev.status === "still-failing") {
      stillFailingNames.push(p.name);
      patternsRetested.add(p.name);
    } else {
      notRetested.push({ patternName: p.name });
    }
  }
  // Carry-overs also count as retested (they showed up in this week's diagnosis).
  for (const p of carryOver) patternsRetested.add(p.name);

  // Filter "new" — drop ones overlapping prev (likely Gemini renaming).
  const newMistakes: WeeklyDelta["newMistakes"] = [];
  for (const cand of newOnes) {
    const candKw = new Set((cand.trigger_keywords ?? []).map(s => s.toLowerCase()));
    const candTok = new Set(cand.name.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4));
    let overlapsPrev = false;
    for (const prevP of prevPatterns) {
      const pKw = new Set((prevP.trigger_keywords ?? []).map(s => s.toLowerCase()));
      const pTok = new Set(prevP.name.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4));
      const kwOverlap  = [...candKw].filter(k => pKw.has(k)).length;
      const tokOverlap = [...candTok].filter(t => pTok.has(t)).length;
      if (kwOverlap >= 2 || tokOverlap >= 2) { overlapsPrev = true; break; }
    }
    if (overlapsPrev) continue;
    // Find a specific WRONG question this week that matches this new
    // pattern. Reuse the same topic/skill/keyword matchers as the
    // win-evidence path, but pick the highest-marksLost match where
    // the kid got it WRONG (so the parent sees the actual mistake).
    const matchers = subjectTopicMatchers(subj, cand);
    const kwRe = patternKeywordRegex(cand);
    let bestWrong: WeekQuestion | null = null;
    let bestLost = 0;
    for (const q of weekQuestions) {
      if (q.marksAvailable === 0 || q.marksAwarded >= q.marksAvailable) continue;
      const haystack = [q.stem, q.markingNotes, q.studentAnswer].filter(Boolean).join(" ");
      const topicHit = matchers.topic.some(r => r.test(q.syllabusTopic ?? ""));
      const subHit   = matchers.sub.some(r => r.test(q.subTopic ?? ""));
      const skillHit = matchers.skill.length > 0 && (q.skillTags ?? []).some(s => matchers.skill.some(r => r.test(s)));
      const kwHit    = kwRe ? kwRe.test(haystack) : false;
      if (!topicHit && !subHit && !skillHit && !kwHit) continue;
      const lost = q.marksAvailable - q.marksAwarded;
      if (lost > bestLost) { bestLost = lost; bestWrong = q; }
    }
    // No concrete this-week example → skip. Showing "new" patterns
    // without evidence reads as filler and risks falsely flagging the
    // kid when the matcher just couldn't find a hit. We only surface
    // a "new mistake" when we can point at the actual question.
    if (!bestWrong) continue;
    newMistakes.push({
      patternName: cand.name,
      patternWhat: cand.what,
      patternAdvice: cand.strategic_advice,
      exampleWrong: {
        paperTitle: bestWrong.paperTitle, questionNum: bestWrong.questionNum,
        topic: bestWrong.syllabusTopic, aw: bestWrong.marksAwarded, av: bestWrong.marksAvailable,
        stem: bestWrong.stem, studentAnswer: bestWrong.studentAnswer,
        markingNotes: bestWrong.markingNotes,
      },
    });
  }

  // Topic progress: ≥5 questions on a topic this week, ≥5pp delta over
  // last week's average.
  const lastTopicTotals = await topicStatsUpTo(studentId, subject, cutoff);
  const thisWeekTopics = new Map<string, { awarded: number; available: number; attempts: number }>();
  for (const q of weekQuestions) {
    if (q.marksAvailable === 0) continue;
    const t = (q.syllabusTopic ?? "").trim(); if (!t) continue;
    const cur = thisWeekTopics.get(t) ?? { awarded: 0, available: 0, attempts: 0 };
    cur.awarded += q.marksAwarded; cur.available += q.marksAvailable; cur.attempts += 1;
    thisWeekTopics.set(t, cur);
  }
  const topicProgress: WeeklyDelta["topicProgress"] = [];
  for (const [topic, tw] of thisWeekTopics) {
    if (tw.attempts < 5) continue;
    const lw = lastTopicTotals.get(topic);
    if (!lw || lw.attempts < 5 || lw.available === 0) continue;
    const thisPct = Math.round((tw.awarded / tw.available) * 100);
    const prevPct = Math.round((lw.awarded / lw.available) * 100);
    const delta = thisPct - prevPct;
    if (delta >= 5) topicProgress.push({ topic, thisPct, prevPct, delta, attemptsThisWeek: tw.attempts });
  }
  topicProgress.sort((a, b) => b.delta - a.delta);

  return {
    prevGeneratedAt: prev.generatedAt,
    currGeneratedAt: curr.generatedAt ?? new Date().toISOString(),
    papersThisWeek: newPapers.length,
    questionsThisWeek: weekQuestions.length,
    caseA,
    prefaceText,
    wins,
    topicProgress,
    newMistakes,
    notRetested,
    patternsRetested: [...patternsRetested],
  };
}
