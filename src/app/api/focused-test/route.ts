import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStudentDifficultyMode, resolveDifficultyFilter, modeWarningLabel } from "@/lib/difficulty-filter";
import { guardCanAssign } from "@/lib/subscription";

/** MCQ = question has transcribed options (4-element array),
 *  image options, or table-format options. */
function hasOptions(q: { transcribedOptions?: unknown; transcribedOptionImages?: unknown; transcribedOptionTable?: unknown }): boolean {
  const opts = q.transcribedOptions;
  const imgs = q.transcribedOptionImages;
  const tbl = q.transcribedOptionTable;
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
  if (tbl && typeof tbl === "object" && Array.isArray((tbl as { rows?: unknown }).rows) && (tbl as { rows: unknown[] }).rows.length === 4) return true;
  return false;
}

function baseNum(questionNum: string) {
  return questionNum.replace(/[a-zA-Z]+$/, "");
}

export async function POST(request: NextRequest) {
  const { parentId, studentId, subject, topic, scheduledFor, type, revisionLevel } = await request.json() as {
    parentId?: string;
    studentId?: string;
    subject?: string;
    topic?: string;
    scheduledFor?: string;
    type?: string;
    // Revision mode — see daily-quiz/route.ts for the contract.
    revisionLevel?: number;
  };
  const scheduledForDate = scheduledFor ? new Date(scheduledFor) : undefined;
  const mcqOnly = type === "mcq";
  // Chinese focused practices are double-length: 完成对话 / 短文填空 etc.
  // are passage-based sections, and pulling only one passage feels too
  // light for a practice. Bumping the target to 2x (e.g. 2 passages
  // for dialogue completion) matches the depth of the real syllabus
  // section. Detection mirrors lib/extraction.ts.
  const subjectLower = (subject ?? "").toLowerCase();
  const isChinese = subjectLower.includes("chinese")
    || (subject ?? "").includes("华文")
    || (subject ?? "").includes("中文")
    || (subject ?? "").includes("华语");
  const TARGET_TOTAL = isChinese ? 20 : 10;
  const TARGET_MCQ_HALF = isChinese ? 10 : 5;
  const TARGET_OEQ_HALF = isChinese ? 10 : 5;

  if (!parentId || !subject || !topic) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const blocked = await guardCanAssign(parentId);
  if (blocked) return blocked;

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { level: true, settings: true },
  });
  // P3 English isn't supported yet — refuse a P3 student requesting
  // an english focused practice. UI hides the option, so this is a
  // defensive guard.
  if (student?.level === 3 && (subject ?? "").toLowerCase().includes("english")) {
    return NextResponse.json({ error: "Primary 3 English is not yet supported." }, { status: 400 });
  }
  // Revision mode: parent picked "revise P{n-1}" in the assign modal.
  // Validated server-side so a tampered request can't drop a P5
  // student to P1.
  const isRevision = typeof revisionLevel === "number"
    && Number.isInteger(revisionLevel)
    && revisionLevel >= 1
    && !!student?.level
    && revisionLevel < student.level;
  const effectiveLevel = isRevision ? revisionLevel : student?.level ?? null;
  // Source papers have inconsistent level formatting ("P5", "Primary 5", "5").
  // Accept all equivalent variants so the filter actually works.
  const levelVariants = effectiveLevel
    ? [`P${effectiveLevel}`, `Primary ${effectiveLevel}`, String(effectiveLevel)]
    : undefined;
  // Parent setting: opt-out of AI-generated synthetic variants.
  // Default ON; only excluded when explicitly false.
  const includeAiQuestions = ((student?.settings as { includeAiQuestions?: unknown } | null)?.includeAiQuestions !== false);

  // Resolve the student's chosen difficulty mode. Applied ABOVE the
  // level/examType filters below — students who picked "easier" only see
  // Lv 1-3 questions first, falling back to Lv 4 if too few, and so on.
  // Revision mode draws across all difficulties.
  const rawDifficultyMode = await getStudentDifficultyMode(studentId ?? "");
  const baseDifficultyFilter = await resolveDifficultyFilter(rawDifficultyMode, studentId ?? "", subject ?? "");
  const difficultyFilter = isRevision
    ? { primary: null, fallback: null }
    : baseDifficultyFilter;

  // Time-of-year exam-type gate (mirrors daily-quiz). In April we shouldn't
  // be drawing EOY/Prelim questions for focused practice — students haven't
  // covered that material yet. Mapping:
  //   Jan – 17 Apr            : WA1
  //   18 Apr – 14 Jul         : WA1, WA2, SA1
  //   15 Jul – Aug            : WA1, WA2, WA3, SA1
  //   Sep – Dec               : every type allowed
  // null = no examType filter.
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  let allowedExamTypes: string[] | null = null;
  if (m < 4 || (m === 4 && d <= 17)) allowedExamTypes = ["WA1"];
  else if (m < 7 || (m === 7 && d <= 14)) allowedExamTypes = ["WA1", "WA2", "SA1"];
  else if (m <= 8) allowedExamTypes = ["WA1", "WA2", "WA3", "SA1"];

  // Revision mode prefers full year-end papers — the lower level was
  // already covered, so EOY/Prelim/SA2 give the broadest recap.
  const REVISION_PREFERRED_EXAM_TYPES = ["EOY", "End of Year", "Prelim", "Preliminary", "SA2"];
  if (isRevision) {
    allowedExamTypes = REVISION_PREFERRED_EXAM_TYPES;
  }

  const questionWhere = (useLevel: boolean, difficultyLevels: number[] | null, examTypes: string[] | null, allowUnrated: boolean = false) => {
    const difficultyClause = difficultyLevels && difficultyLevels.length > 0
      ? (allowUnrated
        ? { OR: [{ difficulty: { in: difficultyLevels } }, { difficulty: null }] }
        : { difficulty: { in: difficultyLevels } })
      : null;
    // Time-of-year examType gate — accept either the bank paper's
    // examType OR the question's syntheticSourceExamType so synthetic
    // rows pass the gate based on their original source paper's term.
    const examTypeClause = examTypes
      ? {
          OR: [
            { examPaper: { examType: { in: examTypes } } },
            { syntheticSourceExamType: { in: examTypes } },
          ],
        }
      : null;
    return {
      syllabusTopic: topic,
      answer: { not: null } as { not: null },
      // Note: do NOT filter by transcribedStem here — multi-part
      // questions (e.g. Q38a, Q38bc) may have the stem only on one
      // part. Filtering by stem at query level drops the other parts
      // and breaks grouping. We filter at the group level below.
      ...(difficultyClause ?? {}),
      ...(examTypeClause ?? {}),
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        subject: { contains: subject, mode: "insensitive" as const },
        ...(useLevel && levelVariants ? { level: { in: levelVariants } } : {}),
        // Honour the parent's "Include AI generated questions" toggle.
        // Reject the synthetic-bank paper entirely when opted out.
        ...(includeAiQuestions ? {} : {
          NOT: [
            { examType: "Synthetic" },
            { title: { startsWith: "[Synthetic Bank]" } },
          ],
        }),
      },
    };
  };

  // Light select: drops the three base64 columns (imageData,
  // answerImageData, diagramImageData) so the topic-matched +
  // sibling + fallback queries don't drag 50–200 KB per row across
  // Railway egress just to pick 10–20 rows out of a 100+ pool. The
  // heavy columns are hydrated AFTER the final selection — same
  // two-phase pattern as /api/daily-quiz. Was the dominant cost in
  // assign-quiz/practice latency once the master bank grew past
  // ~6k questions.
  const questionSelectLight = {
    id: true,
    questionNum: true,
    examPaperId: true,
    answer: true,
    marksAvailable: true,
    syllabusTopic: true,
    transcribedStem: true,
    transcribedOptions: true,
    transcribedOptionImages: true,
    transcribedOptionTable: true,
    transcribedSubparts: true,
    diagramBounds: true,
    sourceQuestionId: true,
    examPaper: {
      select: { year: true, examType: true, school: true, level: true },
    },
  } as const;

  let topicMatched = await prisma.examQuestion.findMany({
    where: questionWhere(true, difficultyFilter.primary, allowedExamTypes),
    select: questionSelectLight,
  });
  // If the time-of-year filter zeroed out the pool (e.g. April with WA1
  // only and the topic only appears in EOY papers), drop the examType
  // filter so the student gets at least some practice. Surface a warning.
  // For revision mode we broaden on a lower threshold (any time the
  // year-end pool is below TARGET_POOL_REVISION) rather than only on
  // empty — the user explicitly asked for "fall back to all WA1/2/3
  // if EOY/Prelim isn't enough".
  let examTypeFellBack = false;
  // Pool thresholds scale with practice length — Chinese targets 20
  // questions, so trigger broaden/fallback when we'd otherwise have
  // fewer than 20 to draw from.
  const TARGET_POOL_REVISION = TARGET_TOTAL;
  const broadenWhen = isRevision
    ? topicMatched.length < TARGET_POOL_REVISION
    : topicMatched.length === 0;
  if (broadenWhen && allowedExamTypes) {
    const broader = await prisma.examQuestion.findMany({
      where: questionWhere(true, difficultyFilter.primary, null),
      select: questionSelectLight,
    });
    if (broader.length > topicMatched.length) {
      topicMatched = broader;
      examTypeFellBack = true;
      if (isRevision) {
        console.log(`[focused-test] revision pool broadened from ${REVISION_PREFERRED_EXAM_TYPES.join("/")} to all exam types (P${effectiveLevel}, ${broader.length} qs)`);
      }
    }
  }
  // If the student-level filter zeroed out but the topic exists in the bank at
  // other levels, fall back to "any level" so English master papers tagged with
  // e.g. level="Primary 5" don't hide from a student whose level is stored as 5.
  let levelFallback = false;
  if (topicMatched.length === 0 && levelVariants) {
    topicMatched = await prisma.examQuestion.findMany({
      where: questionWhere(false, difficultyFilter.primary, null),
      select: questionSelectLight,
    });
    levelFallback = topicMatched.length > 0;
  }
  // Difficulty fallback ladder for non-standard modes:
  //   1. strict primary (e.g. Lv 1-3) — already done above (allowUnrated=false)
  //   2. primary + unrated
  //   3. primary + fallback (e.g. + Lv 4) + unrated
  // We never drop the difficulty cap entirely — for "easier"/"adaptive"
  // mode that would let a Lv 5 'Very Hard' question through, defeating
  // the whole point of the setting.
  let difficultyFellBack = false;
  const TARGET_POOL = TARGET_TOTAL;
  if (difficultyFilter.primary && topicMatched.length < TARGET_POOL) {
    const examTypeArg = examTypeFellBack ? null : allowedExamTypes;
    // Step 2: same levels but include unrated rows.
    const withNull = await prisma.examQuestion.findMany({
      where: questionWhere(true, difficultyFilter.primary, examTypeArg, true),
      select: questionSelectLight,
    });
    if (withNull.length > topicMatched.length) {
      topicMatched = withNull;
      difficultyFellBack = true;
    }
    // Step 3: add the fallback bucket (e.g. Lv 4 for easier mode), still
    // including unrated. No final 'drop all caps' pass — the cap is part
    // of the contract with the parent's difficulty setting.
    if (topicMatched.length < TARGET_POOL && difficultyFilter.fallback) {
      const broadened = [...difficultyFilter.primary, ...difficultyFilter.fallback];
      const withFallback = await prisma.examQuestion.findMany({
        where: questionWhere(true, broadened, examTypeArg, true),
        select: questionSelectLight,
      });
      if (withFallback.length > topicMatched.length) {
        topicMatched = withFallback;
        difficultyFellBack = true;
      }
    }
  }

  if (topicMatched.length === 0) {
    // Diagnostic: tell the caller how many matched each relaxation so they can
    // tell "topic truly missing" from "subject mismatch" from "level mismatch".
    const anySubjectCount = await prisma.examQuestion.count({
      where: {
        syllabusTopic: topic,
        answer: { not: null },
        examPaper: { sourceExamId: null, paperType: null },
      },
    });
    return NextResponse.json({
      error: anySubjectCount > 0
        ? `No clean questions found for "${topic}" in ${subject} master papers. (${anySubjectCount} exist under other subjects.)`
        : `No clean questions found for "${topic}" in any master paper yet.`,
    }, { status: 404 });
  }

  // Pull in every DB sibling for each (examPaperId, baseNum) in the topic-matched set.
  // The topic filter can miss the parent row when only the subpart carries the syllabus
  // topic tag — and the parent is often the row with the diagram/lead stem. Without
  // this, a subpart like "Express the number of lemon muffins..." gets pulled on its
  // own and shows up in practice with no pie chart.
  // BUT: we also need the sibling itself to be on-topic (or untagged — the parent
  // diagram row often has no syllabusTopic). Otherwise a paper that mistakenly
  // tagged Q12c with a different topic from its siblings drags an unrelated
  // question into the practice (parent reported a 'light energy' Q showed up
  // in a 'life cycles' practice this way).
  const siblingKeys = new Set<string>();
  for (const q of topicMatched) siblingKeys.add(`${q.examPaperId}::${baseNum(q.questionNum)}`);
  const siblingWheres = [...siblingKeys].map(k => {
    const [examPaperId, base] = k.split("::");
    return { examPaperId, questionNum: { startsWith: base } };
  });
  const siblings = siblingWheres.length > 0
    ? await prisma.examQuestion.findMany({
        where: {
          OR: siblingWheres,
          answer: { not: null } as { not: null },
          // On-topic OR untagged — keeps the parent/diagram row (which is
          // often untagged) but rejects an off-topic subpart.
          AND: [{ OR: [{ syllabusTopic: topic }, { syllabusTopic: null }] }],
        },
        select: questionSelectLight,
      })
    : [];

  const byId = new Map<string, typeof topicMatched[number]>();
  for (const q of topicMatched) byId.set(q.id, q);
  for (const q of siblings) if (!byId.has(q.id)) byId.set(q.id, q);
  const allQuestions = [...byId.values()];

  type Q = typeof allQuestions[number];
  // Hydrated row: Q + the three base64 columns we dropped from the
  // light select. Populated AFTER the final selection is picked so the
  // bulk pool query stays cheap.
  type HeavyQ = Q & {
    imageData: string;
    answerImageData: string | null;
    diagramImageData: string | null;
  };

  // Normalise a stem for dedup: the same question phrased with different
  // whitespace, punctuation, or a leading question number (e.g. "1. What...",
  // "Q1 What...", "(1) What...") should collapse to one entry. Without this
  // the pool leaks near-duplicates — e.g. the same Science "Light" question
  // copied across several WA2 papers — and the student sees the same question
  // twice in a 10-item practice.
  function normaliseStem(s: string): string {
    return s
      .toLowerCase()
      .replace(/^\s*(?:q\.?\s*)?\(?\s*\d{1,3}\s*[).:]\s*/, "") // leading "1.", "Q1)", "(1):", etc.
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // Fuzzy dedup: schools sometimes print the same question with one
  // or two word swaps ("must" vs "have to", "shown above" vs "shown
  // below"). Exact normaliseStem equality misses these; Jaccard
  // similarity over word-token sets catches them. Threshold 0.95 —
  // tuned conservative so only very near-identical paraphrases
  // collapse; legitimately distinct questions that share an opening
  // clause stay distinct.
  function wordTokens(s: string): Set<string> {
    return new Set(s.split(/\s+/).filter(w => w.length > 2));
  }
  function jaccardSimilar(a: Set<string>, b: Set<string>): boolean {
    if (a.size < 8 || b.size < 8) return false; // too short to compare confidently
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const union = a.size + b.size - inter;
    return union > 0 && inter / union >= 0.95;
  }

  // ── MCQ pool: deduplicate by lineage + normalised stem ──
  // Lineage: a synthetic-bank question carries sourceQuestionId pointing back
  // to the original ExamQuestion. Both `simple` and `similar` variants share
  // that lineage, AND the source's own id equals that lineage. So the source
  // and its variants collapse to ONE entry. This matters because `simple` has
  // a stem nearly identical to the source (only numbers change) which the
  // stem-normaliser alone can't collapse for math.
  const mcqPool: Q[] = [];
  const seenMcqLineages = new Set<string>();
  const seenMcqStems = new Set<string>();
  const seenMcqTokenSets: Set<string>[] = [];
  for (const q of allQuestions) {
    if (!hasOptions(q)) continue;
    const lineage = q.sourceQuestionId || q.id;
    if (seenMcqLineages.has(lineage)) continue;
    const norm = normaliseStem(q.transcribedStem ?? "");
    if (norm && seenMcqStems.has(norm)) continue;
    // Fuzzy near-duplicate check — catches paraphrased copies across
    // different schools' WA2 papers (e.g. "concrete blocks have to be
    // pushed" vs "concrete blocks must be pushed").
    const tokens = norm ? wordTokens(norm) : null;
    if (tokens && seenMcqTokenSets.some(prev => jaccardSimilar(tokens, prev))) continue;
    seenMcqLineages.add(lineage);
    if (norm) seenMcqStems.add(norm);
    if (tokens) seenMcqTokenSets.push(tokens);
    mcqPool.push(q);
  }

  // ── OEQ pool: group by (paperId, baseNum), deduplicate groups by lead stem ─
  // Include ALL questions in the group (even stem-less), since multi-part questions
  // like Q38a (stem-only) + Q38bc (sub-parts) must be kept together.
  const oeqGroupMap = new Map<string, Q[]>();
  for (const q of allQuestions) {
    if (hasOptions(q)) continue;
    const key = `${q.examPaperId}:${baseNum(q.questionNum)}`;
    if (!oeqGroupMap.has(key)) oeqGroupMap.set(key, []);
    oeqGroupMap.get(key)!.push(q);
  }
  for (const group of oeqGroupMap.values()) {
    group.sort((a, b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
  }
  // Keep groups that either have a stem OR text subparts. The stricter
  // renderableOeq filter below enforces stem-on-group[0]-or-subpart-
  // with-text before selection; this pre-filter just rejects entirely
  // empty groups. (Originally also accepted image-only groups via an
  // imageData length check, but renderableOeq would drop them anyway,
  // and imageData lives in the heavy column we no longer pull at pool
  // time.)
  const validGroups = [...oeqGroupMap.values()].filter(g =>
    g.some(q =>
      (q.transcribedStem ?? "").trim() ||
      ((q.transcribedSubparts as Array<{ label: string; text?: string }> | null) ?? [])
        .some(sp => !sp.label.startsWith("_") && (sp.text ?? "").trim())
    )
  );
  // Build a content fingerprint from the normalised stems of ALL siblings in
  // the group PLUS the normalised text of every real subpart. OEQ questions
  // often carry the actual content on subparts, with only a short scenario
  // on the stem — identical questions across two papers can have wildly
  // different stem phrasing but identical subpart text. The fingerprint
  // joins all these pieces and dedups on the combined signature.
  function groupFingerprint(group: Q[]): string {
    const parts: string[] = [];
    for (const q of group) {
      const stemN = normaliseStem(q.transcribedStem ?? "");
      if (stemN) parts.push(stemN);
      const subs = (q.transcribedSubparts as Array<{ label: string; text: string }> | null) ?? [];
      for (const sp of subs) {
        if (sp.label.startsWith("_")) continue;
        const t = normaliseStem(sp.text ?? "");
        if (t) parts.push(`${sp.label}:${t}`);
      }
    }
    return parts.sort().join("|");
  }

  // Dedup OEQ groups by lineage + content fingerprint + Jaccard
  // similarity on the fingerprint tokens (catches paraphrased
  // duplicates across schools, same as the MCQ branch above).
  const oeqPool: Q[][] = [];
  const seenOeqLineages = new Set<string>();
  const seenOeqFingerprints = new Set<string>();
  const seenOeqTokenSets: Set<string>[] = [];
  for (const group of validGroups) {
    const lineage = group[0].sourceQuestionId || group[0].id;
    if (seenOeqLineages.has(lineage)) continue;
    const fp = groupFingerprint(group);
    if (fp && seenOeqFingerprints.has(fp)) continue;
    const tokens = fp ? wordTokens(fp) : null;
    if (tokens && seenOeqTokenSets.some(prev => jaccardSimilar(tokens, prev))) continue;
    seenOeqLineages.add(lineage);
    if (fp) seenOeqFingerprints.add(fp);
    if (tokens) seenOeqTokenSets.push(tokens);
    oeqPool.push(group);
  }

  type Subpart = { label: string; text: string; answer?: string | null; diagramBase64?: string | null; refImageBase64?: string | null };

  function parsePartAnswers(answer: string | null | undefined): Map<string, string> {
    const result = new Map<string, string>();
    if (!answer || !answer.trim()) return result;
    // Accept single-letter labels (a, b, c) AND roman-nested labels like
    // (ai), (aii), (bii), (civ). Matches the widened pattern in lib/marking.ts.
    const re = /(^|[|\n])\s*\(?([a-z](?:i{1,4}|iv|v|vi{0,3})?)\)\s*/gi;
    const matches = [...answer.matchAll(re)];
    if (matches.length === 0) return result;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const label = m[2].toLowerCase();
      const start = m.index! + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index! : answer.length;
      const content = answer.slice(start, end).replace(/\s*\|\s*$/, "").trim();
      if (content) result.set(label, content);
    }
    return result;
  }

  function mergeOeqGroup(group: HeavyQ[]) {
    const first = group[0];
    // Main question stem, main diagram = group[0]'s own values, period. Do NOT
    // promote a later sibling's stem or diagram into the main slots — that
    // content belongs only to the later sibling's subparts. For Q38 where
    // 38a is empty and 38bc has the stem + diagram: the main question stays
    // empty, and 38bc's stem+diagram attach to its own (b) subpart via the
    // prepend/refImageBase64 loop below.
    const leadStem = (first.transcribedStem ?? "").trim();
    const mainDiagram = first.diagramImageData ?? null;
    // imageData is just the cropped snapshot used by the MCQ renderer; OEQ
    // renderer no longer falls back to it. Keep it for storage completeness
    // — pick from any sibling with a real image so the row isn't empty bytes.
    const imageSource = (first.imageData && first.imageData.length > 100)
      ? first
      : (group.find(q => q.imageData && q.imageData.length > 100) ?? first);
    const allSubparts: Subpart[] = [];
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const realSubs = subs.filter(s => !s.label.startsWith("_"));
      const qStem = (q.transcribedStem ?? "").trim();
      // Only prepend for LATER siblings — group[0]'s stem is the main stem,
      // not a subpart preamble. (For q=first, qStem === leadStem, so the
      // qStem !== leadStem guard handles it, but we also explicitly exclude
      // q === first for clarity.)
      const extraStem = q !== first && qStem && qStem !== leadStem ? qStem : "";
      const processed = realSubs.map((sp, idx) => {
        let next = sp;
        if (idx === 0 && extraStem) {
          next = { ...next, text: `${extraStem}\n\n${sp.text ?? ""}`.trim() };
        }
        // Later siblings' diagrams belong to their OWN first subpart, not the
        // main question. For q=first, the diagram is already on mainDiagram.
        if (q !== first && q.diagramImageData && idx === 0 && !next.refImageBase64) {
          const diagramData = q.diagramImageData.replace(/^data:image\/\w+;base64,/, "");
          next = { ...next, refImageBase64: diagramData };
        }
        return next;
      });
      allSubparts.push(...processed);
    }
    const sentinels = group.flatMap(q => ((q.transcribedSubparts as Subpart[] | null) ?? []).filter(s => s.label.startsWith("_")));
    // Aggregate per-part answers across all siblings, then attach to subparts.
    // Also rebuild the flat answer string from the per-part map so every part is present.
    const partAnswers = new Map<string, string>();
    for (const q of group) {
      const parsed = parsePartAnswers(q.answer);
      if (parsed.size > 0) {
        for (const [label, text] of parsed) partAnswers.set(label, text);
        continue;
      }
      // No (a)/(b) markers — if this sibling has exactly one real subpart, use its label
      const sibSubs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      const sibRealSubs = sibSubs.filter(s => !s.label.startsWith("_"));
      if (sibRealSubs.length === 1 && q.answer?.trim()) {
        partAnswers.set(sibRealSubs[0].label.toLowerCase(), q.answer.trim());
      }
    }
    const enrichedSubparts = allSubparts.map(sp => {
      const ans = partAnswers.get(sp.label.toLowerCase());
      return ans !== undefined ? { ...sp, answer: ans } : sp;
    });
    const rebuiltAnswer = partAnswers.size > 0
      ? [...partAnswers.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `(${k}) ${v}`).join(" | ")
      : [...new Set(group.map(q => q.answer).filter(Boolean))].join("\n");
    // Pick the first answer image among siblings (in questionNum order).
    const sortedGroup = [...group].sort((a,b) => a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true }));
    const answerImageData = sortedGroup.find(q => q.answerImageData)?.answerImageData ?? first.answerImageData ?? null;
    return {
      ...first,
      imageData: imageSource.imageData,
      answer: rebuiltAnswer || first.answer,
      answerImageData,
      transcribedStem: leadStem,
      transcribedSubparts: enrichedSubparts.length > 0 ? [...enrichedSubparts, ...sentinels] : null,
      marksAvailable: group.reduce((sum, q) => sum + (q.marksAvailable ?? 1), 0),
      diagramImageData: mainDiagram,
    };
  }

  // Pre-merge filter: an OEQ group is only renderable if the merged question
  // will have AT LEAST ONE of: a non-empty stem on group[0], OR at least one
  // subpart with text content. Without either, the student sees a blank card
  // + a random crop of the paper (imageData). Drop these broken groups rather
  // than selecting them.
  const renderableOeq = oeqPool.filter(group => {
    const firstStem = (group[0].transcribedStem ?? "").trim();
    if (firstStem) return true;
    for (const q of group) {
      const subs = (q.transcribedSubparts as Subpart[] | null) ?? [];
      if (subs.some(sp => !sp.label.startsWith("_") && (sp.text ?? "").trim())) return true;
    }
    return false;
  });

  const shuffle = <T,>(arr: T[]) => arr.sort(() => Math.random() - 0.5);
  shuffle(mcqPool);
  shuffle(renderableOeq);

  // Take up to TARGET_MCQ_HALF MCQ + up to TARGET_OEQ_HALF OEQ; fill
  // remaining slots from whichever has more. When mcqOnly, use only
  // MCQ pool for all TARGET_TOTAL slots. Chinese practices use 2x
  // targets so a 完成对话 / 短文填空 practice runs 2 passages instead
  // of 1.
  const targetMcq = mcqOnly ? Math.min(TARGET_TOTAL, mcqPool.length) : Math.min(TARGET_MCQ_HALF, mcqPool.length);
  const targetOeq = mcqOnly ? 0 : Math.min(TARGET_OEQ_HALF, renderableOeq.length);
  const remaining = TARGET_TOTAL - targetMcq - targetOeq;
  const extraMcq = Math.min(remaining, mcqPool.length - targetMcq);
  const extraOeq = !mcqOnly && remaining - extraMcq > 0 ? Math.min(remaining - extraMcq, renderableOeq.length - targetOeq) : 0;

  const selectedMcq = mcqPool.slice(0, targetMcq + extraMcq);
  const selectedOeqGroups = renderableOeq.slice(0, targetOeq + extraOeq);

  if (selectedMcq.length + selectedOeqGroups.length === 0) {
    return NextResponse.json({ error: "No clean questions found for this topic" }, { status: 404 });
  }

  // Hydration pass: pull the heavy base64 columns for the ~10–20
  // questions we actually picked, plus every sibling row inside each
  // OEQ group (mergeOeqGroup may pick imageData/diagramImageData
  // from any sibling, not just group[0]). One bounded findMany ≪
  // dragging these columns across the whole topic pool.
  const heavyIds = new Set<string>();
  for (const q of selectedMcq) heavyIds.add(q.id);
  for (const g of selectedOeqGroups) for (const q of g) heavyIds.add(q.id);
  const heavyRows = heavyIds.size > 0
    ? await prisma.examQuestion.findMany({
        where: { id: { in: [...heavyIds] } },
        select: { id: true, imageData: true, answerImageData: true, diagramImageData: true },
      })
    : [];
  const heavyById = new Map(heavyRows.map(r => [r.id, r]));
  const hydrate = (q: Q): HeavyQ => {
    const heavy = heavyById.get(q.id);
    return {
      ...q,
      // imageData is non-nullable in the schema; default "" guards
      // against a row going missing between the light and heavy
      // queries (very unlikely but cheap).
      imageData: heavy?.imageData ?? "",
      answerImageData: heavy?.answerImageData ?? null,
      diagramImageData: heavy?.diagramImageData ?? null,
    };
  };

  const hydratedMcq = selectedMcq.map(hydrate);
  const selectedOeq = selectedOeqGroups
    .map(group => group.map(hydrate))
    .map(mergeOeqGroup);
  const allSelected = [...hydratedMcq, ...selectedOeq];

  if (allSelected.length === 0) {
    return NextResponse.json({ error: "No clean questions found for this topic" }, { status: 404 });
  }

  // For revision-mode papers we tag the title with "Revision" and the
  // *actual* level we drew from (effectiveLevel — one below the
  // student's), so the parent dashboard immediately distinguishes
  // a P4 revision practice from a normal P5 one. Non-revision keeps
  // the existing format.
  const labelLevel = effectiveLevel ?? student?.level ?? null;
  const titlePrefix = labelLevel ? `P${labelLevel} ` : "";
  const focusKind = isRevision ? "Revision" : "Focused";
  const paper = await prisma.examPaper.create({
    data: {
      title: `${titlePrefix}${focusKind}: ${topic}`,
      subject,
      level: labelLevel ? `P${labelLevel}` : null,
      userId: parentId,
      assignedToId: studentId || null,
      ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
      paperType: "focused",
      instantFeedback: true,
      pageCount: 0,
      extractionStatus: "ready",
      totalMarks: String(allSelected.reduce((sum, q) => sum + (hasOptions(q) ? 2 : (q.marksAvailable ?? 1)), 0)),
      questions: {
        create: allSelected.map((q, i) => ({
          questionNum: String(i + 1),
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          marksAvailable: hasOptions(q) ? 2 : (q.marksAvailable ?? 1),
          syllabusTopic: q.syllabusTopic,
          pageIndex: 0,
          orderIndex: i,
          transcribedStem: q.transcribedStem,
          transcribedOptions: q.transcribedOptions ?? undefined,
          transcribedOptionImages: q.transcribedOptionImages ?? undefined,
          transcribedOptionTable: q.transcribedOptionTable ?? undefined,
          transcribedSubparts: q.transcribedSubparts ?? undefined,
          diagramImageData: q.diagramImageData,
          diagramBounds: q.diagramBounds ?? undefined,
          sourceQuestionId: q.id,
        })),
      },
    },
  });

  // Build a human warning if the topic had fewer questions than the default target.
  // Default target = 10 (mcqOnly) or 5 MCQ + 5 OEQ (mixed). Surface shortfall so the
  // assigner knows the practice is shorter than usual.
  const warnings: string[] = [];
  const levelName = student?.level ? `P${student.level}` : "this level";
  // No examType-fallback warning. If the fallback pulled enough
  // questions to make a usable practice, the parent doesn't need to
  // know which exam-type bucket they came from. A genuinely short
  // practice still surfaces via the topic-shortfall branch below.
  if (difficultyFellBack) {
    // Friendlier parent-facing wording — internal Lv numbers don't mean
    // anything to the parent. The reality is "we slipped in some
    // slightly harder questions"; that's what they need to know.
    warnings.push(`We have included a few slightly more difficult questions on "${topic}".`);
  }
  if (levelFallback) {
    const levelsUsed = [...new Set(topicMatched.map(q => q.examPaper.level).filter(Boolean))].join(", ");
    warnings.push(`No ${levelName} papers for "${topic}" yet — pulled from ${levelsUsed || "other levels"} instead.`);
  }
  if (mcqOnly) {
    if (mcqPool.length < TARGET_TOTAL) {
      warnings.push(`Only ${mcqPool.length} MCQ question${mcqPool.length === 1 ? "" : "s"} available for "${topic}" at ${levelName}. Practice is shorter than the usual ${TARGET_TOTAL}.`);
    }
  } else {
    if (renderableOeq.length === 0 && mcqPool.length > 0) {
      warnings.push(`No written questions are tagged for "${topic}" at ${levelName} yet — this practice is MCQ-only.`);
    } else if (mcqPool.length === 0 && renderableOeq.length > 0) {
      warnings.push(`No MCQ questions are tagged for "${topic}" at ${levelName} yet — this practice is written-only.`);
    } else if (mcqPool.length + renderableOeq.length < TARGET_TOTAL) {
      warnings.push(`Only ${mcqPool.length} MCQ + ${renderableOeq.length} written question(s) available for "${topic}" at ${levelName}. Practice is shorter than the usual ${TARGET_TOTAL}.`);
    }
  }

  return NextResponse.json({ id: paper.id, questionCount: allSelected.length, warnings });
}
