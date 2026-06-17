// Unified workshop — MCQ + OEQ in one diagnosis.
//
// Combines the OEQ marker-notes track (_workshop-error-patterns-v3)
// and the MCQ option-trap track (_workshop-mcq-patterns) into a
// single pass. Gemini gets both record types in one bundle, finds
// 4 patterns that may span both formats, and the report mixes
// OEQ + MCQ examples per pattern.
//
// Same cache architecture: Flash-Lite image descriptions cached at
// eval/mcq-image-descriptions.json, Pro pattern analysis cached per
// student/subject.
//
// Excludes revision papers (curated past mistakes inflate repeats).
//
// Usage:
//   npx tsx scripts/_workshop-unified.ts "David lim" Science [--refresh]

import { prisma } from "../src/lib/db";
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const [, , studentNameArg, subjectArg, ...rest] = process.argv;
if (!studentNameArg || !subjectArg) {
  console.error("Usage: <studentName> <subject> [--refresh] [--max N]");
  process.exit(1);
}
const forceRefresh = rest.includes("--refresh");
// --fresh treats the run as a brand-new diagnosis: no previousAssessment
// snapshot is carried forward into the new cache. Use when the prompt
// has changed enough that comparing to the prior run is meaningless
// (e.g. the v3 kid-readability prompt rollout in 2026-06).
const freshRun = rest.includes("--fresh");
// --max N — cap wrong records before prompting Gemini. Used for kids
// with hundreds of wrongs (Mark lim, 372) where the full prompt is too
// big for the Node process or for Gemini to emit clean JSON. We keep
// the top-N highest marksLost wrongs so the signal-richest examples
// drive the diagnosis.
const maxIdx = rest.indexOf("--max");
const maxWrongs = maxIdx >= 0 && rest[maxIdx + 1] ? parseInt(rest[maxIdx + 1], 10) : null;

function subjectMatches(rawSubject: string | null, target: string): boolean {
  const t = (rawSubject ?? "").toLowerCase();
  const tgt = target.toLowerCase();
  if (tgt === "science") return t.includes("science");
  if (tgt === "math") return t.includes("math");
  if (tgt === "english") return t.includes("english");
  if (tgt === "chinese") return t.includes("chinese") || (rawSubject ?? "").includes("华文") || (rawSubject ?? "").includes("中文");
  return false;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dataUrl(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("data:")) return raw;
  return `data:image/jpeg;base64,${raw}`;
}

const VISUAL_HINTS = /(diagram|figure|graph|below|shown|picture|table|circuit|food\s*web|food\s*chain|life\s*cycle|set[\s-]*up|apparatus)/i;

// Heuristic — same as v3.
function filterLostMarkParts(notes: string): string {
  const partRegex = /(Part\s*\(([a-z])\)\s*:)/gi;
  const matches = [...notes.matchAll(partRegex)];
  if (matches.length < 2) return notes;
  const parts: { label: string; body: string }[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? notes.length) : notes.length;
    parts.push({ label: m[2].toLowerCase(), body: notes.slice(start, end).trim() });
  }
  const lossSignal = /(Awarded\s+0\s+mark|did\s+not|missed|missing|however|incorrectly|incorrect|too\s+general|too\s+vague)/i;
  const fullCorrect = /correctly|full\s+marks/i;
  const kept = parts.filter(p => {
    if (lossSignal.test(p.body)) return true;
    if (fullCorrect.test(p.body)) return false;
    return true;
  });
  if (kept.length === 0) return notes;
  return kept.map(p => p.body).join("\n\n");
}

function lostSubpartLabels(notes: string): Set<string> {
  const partRegex = /Part\s*\(([a-z])\)\s*:([\s\S]*?)(?=Part\s*\([a-z]\)\s*:|$)/gi;
  const labels = new Set<string>();
  let m: RegExpExecArray | null;
  const lossSignal = /(Awarded\s+0\s+mark|did\s+not|missed|missing|however|incorrectly|incorrect|too\s+general|too\s+vague)/i;
  const fullCorrect = /correctly|full\s+marks/i;
  while ((m = partRegex.exec(notes)) !== null) {
    const label = m[1].toLowerCase();
    const body = m[2];
    if (lossSignal.test(body)) labels.add(label);
    else if (!fullCorrect.test(body)) labels.add(label);
  }
  return labels;
}

(async () => {
  const t0run = Date.now();
  const student = await prisma.user.findFirst({
    where: { name: { equals: studentNameArg, mode: "insensitive" } },
    select: { id: true, name: true, level: true },
  });
  if (!student) { console.error(`Student "${studentNameArg}" not found`); process.exit(1); }
  console.log(`Student: ${student.name} (P${student.level ?? "?"}) id=${student.id}`);

  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: student.id, markingStatus: { in: ["complete", "released"] } },
    select: {
      id: true, title: true, paperType: true, subject: true, completedAt: true,
      metadata: true,
      questions: {
        select: {
          id: true, questionNum: true,
          transcribedStem: true, transcribedSubparts: true, transcribedOptions: true,
          studentAnswer: true, answer: true,
          marksAwarded: true, marksAvailable: true,
          markingNotes: true, syllabusTopic: true,
          elaboration: true,
          diagramImageData: true,
        },
        // Pin the question order so the wrongs idx is reproducible
        // when the same paper is re-loaded by the runtime tutor
        // page (src/lib/tutor.ts mirrors this orderBy).
        orderBy: { orderIndex: "asc" },
      },
    },
    orderBy: { completedAt: "desc" },
  });
  const subjectPapers = papers.filter(p => {
    if (!subjectMatches(p.subject, subjectArg)) return false;
    const meta = p.metadata as { revisionMode?: unknown } | null;
    if (meta?.revisionMode) return false;
    return true;
  });
  console.log(`${subjectArg} papers (excluding revision): ${subjectPapers.length}`);

  type Wrong = {
    idx: number;
    type: "mcq" | "oeq";
    questionId: string;
    paperTitle: string;
    questionNum: string;
    topic: string;
    questionText: string;        // OEQ: stem + relevant subparts; MCQ: stem
    studentAnswer: string;       // OEQ: cleaned answer; MCQ: option number student picked
    correctAnswer: string;
    options: string[];           // MCQ only
    elaboration: string;         // MCQ only
    markingNotes: string;        // OEQ only
    marksAwarded: number; marksAvailable: number; marksLost: number;
    diagramImageData: string | null;
    imageDescription: string | null;
    isVisual: boolean;
  };

  const wrongs: Wrong[] = [];
  // HEADLINE totals must match what the dashboard / progress page
  // shows. The progress page (src/app/api/student-progress/route.ts)
  // excludes revision papers and the page.tsx applies a topic-≥3
  // attempts filter when summing. Mirror both here.
  const HEADLINE_MIN_QS = 3;
  const topicTotals = new Map<string, { attempts: number; awarded: number; available: number }>();
  for (const p of subjectPapers) {
    for (const q of p.questions) {
      const av = q.marksAvailable ?? 0;
      if (av <= 0) continue;
      if (q.studentAnswer === "__SKIPPED__") continue;
      const t = (q.syllabusTopic ?? "").trim();
      if (!t || t === "Untagged") continue;
      const cur = topicTotals.get(t) ?? { attempts: 0, awarded: 0, available: 0 };
      cur.attempts++;
      cur.awarded += q.marksAwarded ?? 0;
      cur.available += av;
      topicTotals.set(t, cur);
    }
  }
  let totalSubjectMarksAvailable = 0;
  let totalSubjectMarksAwarded = 0;
  for (const t of topicTotals.values()) {
    if (t.attempts < HEADLINE_MIN_QS) continue;
    totalSubjectMarksAwarded += t.awarded;
    totalSubjectMarksAvailable += t.available;
  }
  let totalAnswers = 0;
  let idx = 0;

  for (const p of subjectPapers) {
    for (const q of p.questions) {
      totalAnswers++;
      const av = q.marksAvailable ?? 0;
      const aw = q.marksAwarded ?? 0;
      if (av === 0 || aw >= av) continue;
      if (q.studentAnswer === "__SKIPPED__") continue;

      const opts = q.transcribedOptions as unknown;
      const optionsArr: string[] = Array.isArray(opts)
        ? (opts as Array<unknown>).map(o => typeof o === "string" ? o : (o as { text?: string })?.text ?? "").filter(Boolean)
        : [];
      // MCQ detection: either transcribedOptions is populated, OR the
      // marker notes follow the canonical MCQ shape "Student: (X),
      // Correct: (Y)" which the marker pipeline emits for MCQs that
      // were never option-transcribed (options live only in the
      // diagram image).
      const mcqMarkerShape = /Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i;
      const isMcq = optionsArr.length >= 2 || mcqMarkerShape.test(q.markingNotes ?? "");

      // OEQ filter: needs analytical marker notes (>=10 chars and not the canonical MCQ shape).
      // MCQ filter: always include.
      if (!isMcq && (!q.markingNotes || q.markingNotes.trim().length < 10)) continue;

      const stem = (q.transcribedStem ?? "").trim();
      const isVisual = !!q.diagramImageData && (isMcq ? (VISUAL_HINTS.test(stem) || true) : VISUAL_HINTS.test(stem));

      if (isMcq) {
        // Pull elaboration into a usable string.
        let elab = "";
        const eRaw = q.elaboration as unknown;
        if (typeof eRaw === "string") elab = eRaw;
        else if (eRaw && typeof eRaw === "object") {
          const e = eRaw as Record<string, unknown>;
          elab = (e.explanation as string) ?? (e.body as string) ?? (e.text as string) ?? JSON.stringify(e).slice(0, 800);
        }
        wrongs.push({
          idx: ++idx,
          type: "mcq",
          questionId: q.id,
          paperTitle: p.title,
          questionNum: q.questionNum,
          topic: (q.syllabusTopic ?? "").trim() || "—",
          questionText: stem,
          studentAnswer: (q.studentAnswer ?? "").trim(),
          correctAnswer: (q.answer ?? "").trim(),
          options: optionsArr.slice(0, 6),
          elaboration: elab.trim().slice(0, 1200),
          markingNotes: "",
          marksAwarded: aw, marksAvailable: av, marksLost: av - aw,
          diagramImageData: q.diagramImageData ?? null,
          imageDescription: null,
          isVisual,
        });
        continue;
      }

      // OEQ branch — same cleanup as v3.
      const cleanedAnswerRaw = (q.studentAnswer ?? "")
        .replace(/\bworking\s*:\s*[\s\S]*?(?=\bfinal\s*ans|\bans(?:wer)?\s*:|$)/gi, "")
        .replace(/\bfinal\s*ans(?:wer)?\s*:\s*/gi, "")
        .replace(/^ans(?:wer)?\s*:\s*/gi, "")
        .replace(/\(\s*no\s+working\s+(shown|done|written)?\s*\)/gi, "")
        .replace(/\bno\s+working\s+(shown|done|written)\b/gi, "")
        .replace(/\(\s*working\s+shown\s+above\s*\)/gi, "")
        .replace(/^detected\s*:\s*[^.\n]*\.?\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
      // Strip "Detected: ... |" prefix from marker notes.
      let rawNotes = (q.markingNotes ?? "");
      const pipeIdx = rawNotes.search(/\s*\|\s*/);
      if (pipeIdx >= 0 && /detected\s*:/i.test(rawNotes.slice(0, pipeIdx))) {
        rawNotes = rawNotes.slice(pipeIdx).replace(/^\s*\|\s*/, "");
      }
      rawNotes = rawNotes.replace(/^detected\s*:\s*[^.\n]*\.?\s*/i, "").trim();
      const cleanedNotes = filterLostMarkParts(rawNotes);
      // Subpart filter — full question, filter to lost subparts only.
      const subpartsRaw = q.transcribedSubparts as unknown;
      const lostLabels = lostSubpartLabels(cleanedNotes);
      let subpartsText = "";
      if (Array.isArray(subpartsRaw)) {
        const sps = subpartsRaw as Array<{ label?: string; text?: string }>;
        const filtered = lostLabels.size > 0
          ? sps.filter(sp => sp.label && lostLabels.has(sp.label.toLowerCase()))
          : sps;
        subpartsText = filtered.map(sp => `${sp.label ? `(${sp.label}) ` : ""}${sp.text ?? ""}`.trim()).filter(Boolean).join(" ");
      }
      const fullQuestion = [stem, subpartsText.trim()].filter(Boolean).join(" ");
      let scopedAnswer = cleanedAnswerRaw;
      if (lostLabels.size > 0) {
        const partRegex = /\(\s*([a-z])\s*\)([\s\S]*?)(?=\(\s*[a-z]\s*\)|$)/gi;
        const blocks: { label: string; body: string }[] = [];
        let mm: RegExpExecArray | null;
        while ((mm = partRegex.exec(cleanedAnswerRaw)) !== null) {
          blocks.push({ label: mm[1].toLowerCase(), body: mm[0].trim() });
        }
        if (blocks.length >= 2) {
          const kept = blocks.filter(b => lostLabels.has(b.label));
          if (kept.length > 0) scopedAnswer = kept.map(b => b.body).join(" ");
        }
      }

      wrongs.push({
        idx: ++idx,
        type: "oeq",
        questionId: q.id,
        paperTitle: p.title,
        questionNum: q.questionNum,
        topic: (q.syllabusTopic ?? "").trim() || "—",
        questionText: fullQuestion,
        studentAnswer: scopedAnswer,
        correctAnswer: (q.answer ?? "").trim().slice(0, 500),
        options: [],
        elaboration: "",
        markingNotes: cleanedNotes,
        marksAwarded: aw, marksAvailable: av, marksLost: av - aw,
        diagramImageData: q.diagramImageData ?? null,
        imageDescription: null,
        isVisual: VISUAL_HINTS.test(stem),
      });
    }
  }
  const totalSubjectMarksLost = totalSubjectMarksAvailable - totalSubjectMarksAwarded;
  // Apply --max cap BEFORE computing the split + cost / log lines. We
  // sort by marksLost descending (ties → keep original idx ordering so
  // examples stay reproducible) and slice.
  if (maxWrongs !== null && wrongs.length > maxWrongs) {
    console.log(`[compress] capping ${wrongs.length} wrongs → top ${maxWrongs} by marksLost`);
    wrongs.sort((a, b) => (b.marksLost - a.marksLost) || (a.idx - b.idx));
    wrongs.length = maxWrongs;
    // Re-stamp idx so Classification array stays 1..N contiguous.
    wrongs.forEach((w, i) => { w.idx = i + 1; });
  }
  const totalWrongMarksLost = wrongs.reduce((s, w) => s + w.marksLost, 0);
  const wrongMcq = wrongs.filter(w => w.type === "mcq");
  const wrongOeq = wrongs.filter(w => w.type === "oeq");
  console.log(`Wrong records: ${wrongs.length} (${wrongOeq.length} OEQ, ${wrongMcq.length} MCQ)`);
  console.log(`Subject marks: ${totalSubjectMarksAwarded}/${totalSubjectMarksAvailable} (lost: ${totalSubjectMarksLost})`);

  // ----- Image descriptions (Flash-Lite, batched, cached) -----
  // Only MCQ visuals get described — OEQ examples render their raw
  // image inline in the HTML so we don't need a description for them.
  const evalDir = path.join(process.cwd(), "eval");
  if (!existsSync(evalDir)) mkdirSync(evalDir, { recursive: true });
  const descCachePath = path.join(evalDir, "mcq-image-descriptions.json");
  let descCache: Record<string, string> = {};
  if (existsSync(descCachePath)) {
    try { descCache = JSON.parse(readFileSync(descCachePath, "utf8")); } catch { descCache = {}; }
  }
  for (const w of wrongMcq) {
    if (descCache[w.questionId]) w.imageDescription = descCache[w.questionId];
  }
  const needDescribe = wrongMcq.filter(w => w.isVisual && w.diagramImageData && !w.imageDescription);
  console.log(`MCQ image descriptions: cached=${wrongMcq.filter(w => w.imageDescription).length}, need fresh=${needDescribe.length}`);

  let flashCost = 0;
  if (needDescribe.length > 0) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 90_000 } });
    const BATCH = 12;
    for (let i = 0; i < needDescribe.length; i += BATCH) {
      const batch = needDescribe.slice(i, i + BATCH);
      console.log(`  Describing batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(needDescribe.length / BATCH)} (${batch.length} images)…`);
      const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
      parts.push({ text: `I will show you ${batch.length} images, each from a primary school Science MCQ. For each one, describe in 1-2 sentences ONLY what's needed to reason about a related multiple-choice question — shapes, labels, organisms, arrows, structures, comparison points. Skip aesthetics.

Output strict JSON: { "descriptions": [ { "id": 1, "description": "..." }, ... ] }

` });
      for (let j = 0; j < batch.length; j++) {
        const w = batch[j];
        parts.push({ text: `--- Image [${j + 1}] (Q${w.questionNum} from "${w.paperTitle}", topic: ${w.topic}) ---` });
        parts.push({ inlineData: { mimeType: "image/jpeg", data: w.diagramImageData! } });
      }
      try {
        const resp = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite-preview",
          contents: [{ role: "user", parts }],
          config: { temperature: 0.1, responseMimeType: "application/json" },
        });
        const text = (resp.text ?? "").trim();
        const parsed = JSON.parse(text) as { descriptions: Array<{ id: number; description: string }> };
        for (const d of parsed.descriptions) {
          const w = batch[d.id - 1];
          if (!w) continue;
          w.imageDescription = d.description;
          descCache[w.questionId] = d.description;
        }
        writeFileSync(descCachePath, JSON.stringify(descCache, null, 2));
        // Rough cost: ~1290 tokens per image, $0.075/M input for flash-lite-preview.
        flashCost += batch.length * 1290 * 0.075 / 1_000_000;
      } catch (err) {
        console.error(`  Batch failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  console.log(`Flash-Lite spent: ~$${flashCost.toFixed(4)}`);

  // ----- Same-question repeats -----
  const fingerprint = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim().slice(0, 180);
  const byStem = new Map<string, Wrong[]>();
  for (const w of wrongs) {
    const fp = fingerprint(w.questionText);
    if (fp.length < 40) continue;
    if (!byStem.has(fp)) byStem.set(fp, []);
    byStem.get(fp)!.push(w);
  }
  const repeatClusters = [...byStem.values()].filter(arr => arr.length >= 2).sort((a, b) => b.length - a.length);
  const totalRepeatMarksLost = repeatClusters.reduce((s, arr) => s + arr.reduce((ss, w) => ss + w.marksLost, 0), 0);
  console.log(`Repeat clusters: ${repeatClusters.length}, total repeat marks lost: ${totalRepeatMarksLost}`);

  // ----- Build unified prompt -----
  const records = wrongs.map(w => {
    if (w.type === "oeq") {
      return `[${w.idx}] (OEQ) paper="${w.paperTitle}" Q${w.questionNum} topic="${w.topic}" marks=${w.marksAwarded}/${w.marksAvailable}
  question: ${w.questionText.replace(/\s+/g, " ")}
  student wrote: ${w.studentAnswer.replace(/\s+/g, " ")}
  correct: ${w.correctAnswer.replace(/\s+/g, " ")}
  marker notes: ${w.markingNotes.replace(/\s+/g, " ")}`;
    } else {
      const opts = w.options.map((o, k) => `(${k + 1}) ${o.replace(/\s+/g, " ")}`).join("  ");
      return `[${w.idx}] (MCQ) paper="${w.paperTitle}" Q${w.questionNum} topic="${w.topic}" marks=${w.marksAwarded}/${w.marksAvailable}
  question: ${w.questionText.replace(/\s+/g, " ")}
  options: ${opts}
  student picked: ${w.studentAnswer}
  correct: ${w.correctAnswer}
${w.imageDescription ? `  image: ${w.imageDescription.replace(/\s+/g, " ")}\n` : ""}  explanation: ${w.elaboration.replace(/\s+/g, " ")}`;
    }
  }).join("\n\n");

  const repeatBlock = repeatClusters.length > 0
    ? `\n\nIMPORTANT — SAME-QUESTION REPEATS: This student got the SAME question wrong multiple times. Weight heavily. Clusters:\n${repeatClusters.slice(0, 8).map(arr => `  ×${arr.length} attempts — refs: ${arr.map(w => `[${w.idx}]`).join(" ")}`).join("\n")}`
    : "";

  const childFirst = student.name.split(/\s+/)[0] ?? student.name;
  const prompt = `You are an experienced primary-school tutor producing a personalised diagnosis for ${childFirst} in ${subjectArg}. Below are every question ${childFirst} got partially or fully wrong (${wrongs.length} records total: ${wrongOeq.length} open-ended + ${wrongMcq.length} multiple-choice). For OEQ records you have the marker's analytical notes. For MCQ records you have the options, ${childFirst}'s pick, the correct pick, and the AI-generated explanation of the correct answer.

TONE — this report is read by a parent who will work through it WITH their child. Be warm and constructive, never clinical. Use ${childFirst}'s first name (NEVER "the student"). Use gentle qualifiers: "${childFirst} sometimes…", "occasionally", "tends to" — NOT "struggles", "fails", "cannot", "consistently". The goal is to point at fixable habits, not to label a deficiency.

Identify the TOP 3 OR 4 RECURRING ERROR PATTERNS that may span both formats. DO NOT pre-define a taxonomy — let patterns emerge. Patterns describing HOW/WHY marks are lost (e.g. "Stops one step short before stating the final consequence", "Misses negation words like 'not' or 'except'") are stronger than topic-specific ones.

TWO TYPES of pattern to look for — surface a MIX when both are present:
  (A) PROCEDURAL slips — how the child handles a question (skipped step, wrong reference whole, missed cue word, miscounted units).
  (B) CONCEPTUAL confusions — the child mixes up two distinct concepts. Use words like "Mix-Up", "Confusion", "Mixes Up", "Confuses" in the name so the runtime classifies it correctly. Subject-specific examples we expect to see:
      • Science: Force vs Energy · Heat vs Temperature · KE vs PE (kinetic vs potential energy) · Mass vs Weight · Volume vs Capacity · Series vs Parallel circuit behaviour · Reflection vs Refraction · Solute vs Solvent · Living vs Non-living traits
      • English: Reported Speech Tenses (direct → reported tense shift) · Subject–Verb Agreement (singular/plural) · "Few" vs "A Few" · "Since" vs "For" · "Make" vs "Do" · Present Perfect vs Past Simple
      • Math: Area vs Perimeter · Multiple vs Factor · Ratio vs Fraction (which is the "whole") · Mean vs Median · Volume vs Surface Area · Mass vs Weight

THRESHOLD GUIDANCE for surfacing a conceptual confusion: even ONE clear instance of the SAME concept-pair confusion counts — you do not need 3+ examples to substantiate. A pattern accounting for as little as 1-2% of total marks lost is worth surfacing if it cleanly names a concept the child has muddled.

PREFER 3 STRONG PATTERNS OVER 4 WEAK ONES — if the signal for a 4th pattern is generic ("occasional arithmetic slips", "tricky spellings", "format details"), drop it and emit 3 instead. But — if the candidate 4th IS a clear conceptual confusion, keep it even at a lower marks-lost share.

The summary will frame these as "what we can work on this week", so a tight set of well-named patterns beats a padded list.

THEN classify EVERY record [1..${wrongs.length}] into exactly one of the patterns (patternIndex 0-2 or 0-3). Records that don't fit → patternIndex -1.

For each pattern provide:
  name — 2 to 4 WORDS. Must satisfy ALL THREE rules:
    (a) READABLE BY A PRIMARY 5 KID. Use everyday words. Banned vocabulary (academic / jargon):
        "composite", "premature", "transcription", "notation", "reversal", "scenarios", "reference whole",
        "boundaries", "configuration", "elaboration", "delineation", "demarcation", "magnitude".
        If you'd hesitate to use the word with a 10-year-old, pick a simpler one.
    (b) NO ABSTRACT-ACADEMIC GERUND OPENER. Banned: "Mastering", "Pinpointing", "Tracing", "Visualising",
        "Visualizing", "Navigating", "Understanding", "Misidentifying", "Comprehending", "Overlooking",
        "Identifying", "Determining", "Calculating", "Analysing".
        CONCRETE kid-friendly gerunds ARE OK as openers when they are immediately clear: "Copying Errors",
        "Skipping Questions", "Reading the Question", "Stopping Too Early" — all acceptable.
    (c) MUST BE QUOTABLE IN A PARENT-TO-PARENT WHATSAPP MESSAGE. The parent should be able to say
        "Lumi found a pattern called [name]" without explaining what the words mean.

    Good examples (pass all three): "One Step Short", "Wrong Total Used", "Ratio in Wrong Order",
    "Combined Shapes Trap", "Copying Numbers Wrong", "Line Naming", "Forgotten Units",
    "Compass Direction Mix-Up", "Before and After Problems", "Trap-Matching MCQs", "Hidden 3D Faces",
    "Place Value Slips", "Reported Speech Tenses".

    Bad examples (fail one or more rules):
      "Composite Figure Boundaries"  — fails (a): "composite" + "boundaries" are too academic.
      "Premature Final Answer"       — fails (a): "premature".
      "Number Transcription Slips"   — fails (a): "transcription".
      "Reference Whole Confusion"    — fails (a): "reference whole" is math jargon.
      "Ratio Order Reversal"         — fails (a): "reversal" is academic.
      "Geometry Line Notation"       — fails (a): "notation".
      "Before and After Scenarios"   — fails (a): "scenarios".
      "Mastering Experimental Design"— fails (b): abstract academic gerund opener.

    RULE: if your name contains any word from the banned vocabulary list, REWRITE IT with a simpler word.
  what — one sentence describing the pattern. RULES:
    • DO NOT start with the kid's name. Lead with a present-tense verb.
    • Gentle qualifiers like "sometimes" / "occasionally" / "tends to" are GOOD — they're accurate and warm.
    • Praise is OK when warranted, but the diagnosis must be in the FIRST HALF of the sentence, not buried after a "BUT".
    Good: "Sometimes calculates the next fraction using the original total instead of the leftover."
    Bad (kid name opener): "${childFirst} sometimes does the heavy lifting to find an intermediate value, but occasionally stops one step short of the final question."  ← if your sentence starts with "${childFirst}" or any first name, REWRITE IT to start with a verb.
    Bad (praise burial): "${childFirst} often sets up the maths beautifully, but occasionally makes a small slip."  ← put the diagnosis first.
  DO NOT EMIT TWO PATTERNS ABOUT THE SAME THING. Each pattern must be distinct from the others — no two patterns about units, no two patterns about ratio reading, no two patterns about reading the question carefully. If two candidate patterns overlap heavily, merge them or drop the weaker one.
  specific_examples — 2 to 3 examples. PROCEDURAL patterns: 3 examples preferred. CONCEPTUAL confusions: 2 is enough — when a concept-pair confusion is clear, 2 well-chosen examples substantiate it without padding. Pick from records classified into this pattern, prefer a MIX of OEQ and MCQ when both formats are present. Each:
    questionRef — e.g. "[49]"
    type — "oeq" or "mcq"
    whatWentWrong — one sentence diagnosis (concise, parent-readable, same warm tone — use the first name or "he/she" not "the student")
  strategic_advice — actionable coaching keyed to question-stem TRIGGER WORDS. 2-4 sentences OR a bulleted list. WRAP KEY PHRASES IN **double-asterisk markdown** to render bold.
    USE BULLETS (lines starting with "- ") if there are multiple trigger phrases or multiple distinct coaching moves. Use prose if it's one core move.
    Example (prose): "When you see **'explain why'**, always include a **'so that…'** clause showing the final consequence."
    Example (bullets): "When you see these prompts, treat them as stop signs:
      - **'of the remaining'** → use the leftover, not the original total
      - **'how much more'** → subtract, then double-check whose value is bigger"
  trigger_keywords — question-stem phrases that flag this pattern

OUTPUT STRICT JSON:
{
  "patterns": [
    { "name": "...", "what": "...", "specific_examples": [...], "strategic_advice": "...", "trigger_keywords": [...] }
  ],
  "classification": [ { "idx": 1, "patternIndex": 0 }, ... ]
}

The patterns array MUST have 3 or 4 entries. The classification array MUST have exactly ${wrongs.length} entries.${repeatBlock}

DATA:

${records}`;

  console.log(`\nPrompt size: ${(prompt.length / 1000).toFixed(1)}K chars (~${Math.round(prompt.length / 4 / 1000)}K tokens)`);

  const safeStu = student.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const cachePath = path.join(evalDir, `unified-diagnosis-${safeStu}-${subjectArg.toLowerCase()}.gemini-cache.json`);

  type Example = { questionRef: string; type: "oeq" | "mcq"; whatWentWrong: string };
  type Pattern = { name: string; what: string; specific_examples: Example[]; strategic_advice: string; trigger_keywords: string[] };
  type Classification = { idx: number; patternIndex: number };
  // Snapshot of the prior assessment, carried into the new cache when
  // we refresh — lets the runtime LumiSummary call out which patterns
  // the kid has moved past since the last check.
  type PreviousAssessment = {
    generatedAt: string;
    patternNames: string[];
    wrongCounts: { total: number; oeq: number; mcq: number } | null;
    toplineSnapshot: { avgPct: number; totalAwarded: number; totalAvailable: number; paperCount: number } | null;
  };
  type ToplineSnapshot = { avgPct: number; totalAwarded: number; totalAvailable: number; paperCount: number };
  type Report = {
    patterns: Pattern[];
    classification: Classification[];
    // Resolution metadata — added so the runtime tutor loader can
    // resolve examples + classifications by stable questionId instead
    // of an idx that drifts every time a new paper is completed. The
    // generatedAt timestamp + wrongs counts let the loader detect when
    // a kid's cache is stale (new wrong records have appeared since
    // the workshop run) and flag the response for the UI banner.
    questionIdByIdx?: Record<string, string>;
    generatedAt?: string;
    wrongCounts?: { total: number; oeq: number; mcq: number };
    // Topline snapshot at workshop time — frozen so the next refresh
    // can compute "avg up 4pp since last check" without re-running the
    // prior assessment's prisma query.
    toplineSnapshot?: ToplineSnapshot;
    // Single-step history. When the workshop overwrites a prior cache,
    // we lift the prior's diagnosis summary into this field so the
    // runtime can say e.g. "since last check, these 2 patterns dropped
    // out of the top 4 — nice work".
    previousAssessment?: PreviousAssessment | null;
  };

  // Compute the topline snapshot up front; the same numbers were
  // already logged earlier in this run.
  const paperCountForSnapshot = (() => {
    // Count distinct nonRevPapers wrong records touched. We don't have
    // a clean handle to nonRevPapers here, but totalSubjectMarksAvailable
    // is already in scope, and the wrongs array is per-question. Re-use
    // the count we already logged.
    return papers.filter(p => !(p.metadata as { revisionMode?: unknown } | null)?.revisionMode && subjectMatches(p.subject, subjectArg)).length;
  })();
  const currentToplineSnapshot: ToplineSnapshot = {
    avgPct: totalSubjectMarksAvailable > 0 ? Math.round((totalSubjectMarksAwarded / totalSubjectMarksAvailable) * 100) : 0,
    totalAwarded: totalSubjectMarksAwarded,
    totalAvailable: totalSubjectMarksAvailable,
    paperCount: paperCountForSnapshot,
  };

  let report: Report;
  let proCost = 0;
  if (!forceRefresh && !freshRun && existsSync(cachePath)) {
    console.log(`Using cached Pro analysis (${cachePath}). Pass --refresh to force.`);
    report = JSON.parse(readFileSync(cachePath, "utf8"));
  } else {
    // Snapshot the prior assessment BEFORE we overwrite it. The new
    // cache carries forward enough of the old to compute a delta at
    // render time. Skipped for --fresh runs (treat as brand-new).
    let previousAssessment: PreviousAssessment | null = null;
    if (!freshRun && existsSync(cachePath)) {
      try {
        const prior = JSON.parse(readFileSync(cachePath, "utf8")) as Report;
        if (prior.generatedAt) {
          previousAssessment = {
            generatedAt: prior.generatedAt,
            patternNames: (prior.patterns ?? []).map(p => p.name),
            wrongCounts: prior.wrongCounts ?? null,
            toplineSnapshot: prior.toplineSnapshot ?? null,
          };
          console.log(`Prior assessment from ${prior.generatedAt} archived as previousAssessment.`);
        }
      } catch (e) {
        console.warn(`Could not parse prior cache to snapshot previousAssessment: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (freshRun && existsSync(cachePath)) {
      console.log(`--fresh: not snapshotting previousAssessment; treating as a brand-new diagnosis.`);
    }
    console.log(`Calling Gemini 3.1 Pro…\n`);
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 170_000 } });
    const t0 = Date.now();
    const resp = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      // Higher kids (Mark, 119 wrong records) need a bigger budget — the
      // default cut Mark's report off at 10K chars / ~2.5K tokens
      // mid-JSON. 32K leaves plenty of headroom for the largest case.
      config: { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 32768 },
    });
    console.log(`Pro responded in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${(resp.text ?? "").length} chars`);
    report = JSON.parse((resp.text ?? "").trim()) as Report;
    // Stamp resolution metadata into the cache. questionIdByIdx maps
    // every idx the diagnosis references back to the actual question
    // id, so the runtime loader can resolve by stable identity even
    // after new papers shift the idx ordering. generatedAt + wrongCounts
    // power the staleness check.
    report.questionIdByIdx = Object.fromEntries(wrongs.map(w => [String(w.idx), w.questionId]));
    report.generatedAt = new Date().toISOString();
    report.wrongCounts = { total: wrongs.length, oeq: wrongOeq.length, mcq: wrongMcq.length };
    report.toplineSnapshot = currentToplineSnapshot;
    report.previousAssessment = previousAssessment;
    writeFileSync(cachePath, JSON.stringify(report, null, 2));
    // Cost estimate: $1.25/M input + $10/M output.
    const promptTokens = Math.round(prompt.length / 4);
    const outputTokens = Math.round((resp.text ?? "").length / 4);
    proCost = (promptTokens * 1.25 + outputTokens * 10) / 1_000_000;
    console.log(`Pro spent: ~$${proCost.toFixed(4)}`);
  }

  // ----- Marks-lost per pattern -----
  const wrongByIdx = new Map(wrongs.map(w => [w.idx, w]));
  const marksLostByPattern = new Array(report.patterns.length).fill(0);
  // Per-pattern topic distribution — used to surface a "Focused
  // Practice on <topic>" recommendation when one syllabus topic
  // dominates the pattern (e.g. "Confusing Reproductive Roles" is
  // really a topic gap, not just a technique gap).
  const patternTopicCounts: Array<Map<string, { count: number; marks: number }>> = report.patterns.map(() => new Map());
  let otherMarksLost = 0, otherCount = 0, classifiedCount = 0;
  for (const c of report.classification) {
    const w = wrongByIdx.get(c.idx);
    if (!w) continue;
    if (c.patternIndex >= 0 && c.patternIndex < report.patterns.length) {
      marksLostByPattern[c.patternIndex] += w.marksLost;
      classifiedCount++;
      const m = patternTopicCounts[c.patternIndex];
      const cur = m.get(w.topic) ?? { count: 0, marks: 0 };
      cur.count++; cur.marks += w.marksLost;
      m.set(w.topic, cur);
    } else { otherMarksLost += w.marksLost; otherCount++; }
  }
  // For each pattern: pick the dominant topic if it accounts for ≥40%
  // of the pattern's classified records AND ≥3 records (otherwise too
  // thin to recommend a topic).
  const dominantTopicByPattern: Array<{ topic: string; share: number } | null> = patternTopicCounts.map(m => {
    if (m.size === 0) return null;
    const total = [...m.values()].reduce((s, v) => s + v.count, 0);
    let best: { topic: string; count: number } | null = null;
    for (const [t, v] of m.entries()) {
      if (t === "—" || t === "Untagged") continue;
      if (!best || v.count > best.count) best = { topic: t, count: v.count };
    }
    if (!best || best.count < 3) return null;
    const share = best.count / total;
    if (share < 0.4) return null;
    return { topic: best.topic, share };
  });
  const subjectAvgPct = totalSubjectMarksAvailable > 0 ? Math.round((totalSubjectMarksAwarded / totalSubjectMarksAvailable) * 100) : 0;
  const top4MarksLost = marksLostByPattern.reduce((s, n) => s + n, 0);
  const boostedScorePct = totalSubjectMarksAvailable > 0 ? Math.round(((totalSubjectMarksAwarded + top4MarksLost) / totalSubjectMarksAvailable) * 100) : 0;

  console.log(`\nMarks-lost per pattern:`);
  for (let pi = 0; pi < report.patterns.length; pi++) {
    const lost = marksLostByPattern[pi];
    const pct = totalWrongMarksLost > 0 ? Math.round((lost / totalWrongMarksLost) * 100) : 0;
    console.log(`  ${pi + 1}. ${report.patterns[pi].name.padEnd(45)} ${String(lost).padStart(5)} marks (${pct}%)`);
  }
  if (otherCount > 0) console.log(`  -- Other (${otherCount} records) ${otherMarksLost} marks`);

  // ----- HTML rendering -----
  const subjectLower = subjectArg.toLowerCase();
  const boldify = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const cleanPaperTitle = (t: string) =>
    t.replace(/^\s*\[[A-Z_-]+\]\s*/g, "").replace(/\s*\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z)?\)\s*$/g, "").trim();
  const refToWrong = (ref: string): Wrong | null => {
    const m = /\[(\d+)\]/.exec(ref);
    if (!m) return null;
    return wrongByIdx.get(parseInt(m[1], 10)) ?? null;
  };

  const renderOeqExample = (w: Wrong, fallbackNotes: string) => {
    const img = dataUrl(w.diagramImageData);
    const imgHtml = img ? `<img src="${img}" alt="Question image" style="display:block;max-width:100%;border:1px solid #e5eeff;border-radius:8px;margin:8px 0;" />` : "";
    return `
      <div style="border-left:3px solid #c4b5fd;padding:12px 16px;margin:12px 0;background:#faf9ff;border-radius:0 10px 10px 0;">
        <p style="margin:0 0 6px 0;color:#5b21b6;font-size:11px;font-weight:700;">EXAMPLE (OEQ) — ${esc(cleanPaperTitle(w.paperTitle))}</p>
        <p style="margin:6px 0 6px 0;color:#001e40;font-size:13px;line-height:1.5;white-space:pre-line;"><strong>Question:</strong> ${esc(w.questionText)}</p>
        ${imgHtml}
        <p style="margin:8px 0 6px 0;color:#9f1239;font-size:13px;line-height:1.5;white-space:pre-line;"><strong>${esc(childFirst)} wrote:</strong> ${esc(w.studentAnswer || "(blank)")}</p>
        <p style="margin:8px 0 0 0;color:#43474f;font-size:13px;line-height:1.5;white-space:pre-line;"><strong>What ${esc(childFirst)} missed:</strong> ${boldify(w.markingNotes || fallbackNotes)}</p>
      </div>`;
  };
  const renderMcqExample = (w: Wrong, fallbackReason: string) => {
    const img = dataUrl(w.diagramImageData);
    const imgHtml = img ? `<img src="${img}" alt="Question diagram" style="display:block;max-width:100%;border:1px solid #e5eeff;border-radius:8px;margin:8px 0;" />` : "";
    // When options were transcribed: render the colored table.
    // When they weren't (options live only in the diagram image
    // above): render a compact picked/correct strip instead.
    const pickedNum = (w.studentAnswer.match(/\d+/) ?? [""])[0];
    const correctNum = (w.correctAnswer.match(/\d+/) ?? [""])[0];
    const optionsHtml = w.options.length > 0
      ? `<div style="margin:8px 0;">${w.options.map((o, k) => {
          const num = String(k + 1);
          const isPicked = pickedNum === num;
          const isCorrect = correctNum === num;
          const bg = isCorrect ? "#d1fae5" : isPicked ? "#fee2e2" : "#f9fafb";
          const color = isCorrect ? "#047857" : isPicked ? "#9f1239" : "#43474f";
          const tag = isCorrect ? " ✓ correct" : isPicked ? ` ✗ ${esc(childFirst)} picked` : "";
          return `<div style="padding:6px 12px;margin:3px 0;background:${bg};color:${color};border-radius:6px;font-size:12.5px;line-height:1.4;"><strong>(${num})</strong> ${esc(o)}${tag ? `<span style="font-weight:700;float:right;">${tag}</span>` : ""}</div>`;
        }).join("")}</div>`
      : `<div style="display:flex;gap:10px;margin:10px 0;flex-wrap:wrap;">
          <span style="padding:8px 14px;background:#fee2e2;color:#9f1239;border-radius:8px;font-size:13px;font-weight:700;">${esc(childFirst)} picked: <strong>(${esc(pickedNum) || "?"})</strong> ✗</span>
          <span style="padding:8px 14px;background:#d1fae5;color:#047857;border-radius:8px;font-size:13px;font-weight:700;">Correct: <strong>(${esc(correctNum) || "?"})</strong> ✓</span>
        </div>`;
    return `
      <div style="border-left:3px solid #fbbf24;padding:12px 16px;margin:12px 0;background:#fffbeb;border-radius:0 10px 10px 0;">
        <p style="margin:0 0 6px 0;color:#9a3412;font-size:11px;font-weight:700;">EXAMPLE (MCQ) — ${esc(cleanPaperTitle(w.paperTitle))}</p>
        <p style="margin:6px 0 6px 0;color:#001e40;font-size:13px;line-height:1.5;white-space:pre-line;"><strong>Question:</strong> ${esc(w.questionText)}</p>
        ${imgHtml}
        ${optionsHtml}
        <p style="margin:8px 0 0 0;color:#43474f;font-size:13px;line-height:1.5;white-space:pre-line;"><strong>Why ${esc(childFirst)} was tricked:</strong> ${boldify(fallbackReason)}</p>
      </div>`;
  };

  const patternsBlock = report.patterns.map((p, pi) => {
    const lost = marksLostByPattern[pi];
    const pctOfLost = totalWrongMarksLost > 0 ? Math.round((lost / totalWrongMarksLost) * 100) : 0;
    const renderExample = (ex: Example) => {
      const w = refToWrong(ex.questionRef);
      if (!w) return "";
      return w.type === "mcq" ? renderMcqExample(w, ex.whatWentWrong) : renderOeqExample(w, ex.whatWentWrong);
    };
    const first = p.specific_examples[0] ? renderExample(p.specific_examples[0]) : "";
    const more = p.specific_examples.slice(1);
    const moreHtml = more.length > 0
      ? `<details style="margin-top:4px;"><summary style="cursor:pointer;color:#5b21b6;font-size:12px;font-weight:700;padding:6px 0;list-style:none;">See ${more.length} more example${more.length === 1 ? "" : "s"} ▾</summary>${more.map(renderExample).join("")}</details>`
      : "";
    const triggerHtml = p.trigger_keywords.length
      ? `<p style="margin:10px 0 0 0;color:#43474f;font-size:12px;"><span style="font-weight:700;">Trigger words to watch for:</span> ${p.trigger_keywords.map(t => `<span style="display:inline-block;background:#fde68a;color:#78350f;padding:2px 8px;border-radius:999px;margin:0 4px 4px 0;font-size:11px;font-weight:700;">${esc(t)}</span>`).join("")}</p>`
      : "";
    // Topic-specific reinforcement: when one syllabus topic dominates
    // this pattern (≥40% of records), surface a "Focused Practice"
    // CTA on that topic alongside the technique advice.
    const dom = dominantTopicByPattern[pi];
    const topicCtaHtml = dom
      ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px 16px;margin-top:10px;">
           <p style="margin:0;color:#9a3412;font-size:13px;line-height:1.5;white-space:pre-line;">
             <strong>Also:</strong> ${Math.round(dom.share * 100)}% of this pattern's mistakes are on <strong>${esc(dom.topic)}</strong> — worth a <a href="#" style="color:#9a3412;text-decoration:underline;font-weight:700;">Focused Practice on ${esc(dom.topic)}</a> too.
           </p>
         </div>`
      : "";
    return `
      <div style="border:1px solid #ddd6fe;border-radius:14px;padding:20px;margin:20px 0;background:#ffffff;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
          <h3 style="margin:0;color:#001e40;font-size:18px;font-weight:800;">${pi + 1}. ${esc(p.name)}</h3>
          <span style="color:#7c3aed;font-size:13px;font-weight:800;white-space:nowrap;">${lost} marks lost · ${pctOfLost}% of total</span>
        </div>
        <p style="margin:0 0 12px 0;color:#43474f;font-size:14px;line-height:1.55;">${esc(p.what)}</p>
        ${first}${moreHtml}
        <div style="background:#ecfdf5;border:1px solid #b6f0ce;border-radius:10px;padding:14px 16px;margin-top:14px;">
          <p style="margin:0 0 6px 0;color:#047857;font-size:11px;font-weight:700;letter-spacing:0.5px;">ADVICE</p>
          <p style="margin:0;color:#065f46;font-size:13.5px;line-height:1.6;">${boldify(p.strategic_advice)}</p>
          ${triggerHtml}
        </div>
        ${topicCtaHtml}
      </div>`;
  }).join("");

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#001e40;background:#f4f6fb;margin:0;padding:24px 12px;">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e5eeff;">
    <h1 style="font-size:30px;margin:8px 0 18px 0;color:#001e40;font-weight:900;letter-spacing:-0.3px;line-height:1.2;">${esc(childFirst)}'s Personalised ${esc(subjectArg)} Diagnosis</h1>
    <div style="background:#ecfdf5;border:1px solid #b6f0ce;border-radius:12px;padding:18px 22px;margin:0 0 18px 0;">
      <p style="margin:0;color:#065f46;font-size:15.5px;line-height:1.6;font-weight:600;">
        We've deep-dived into ${esc(childFirst)}'s ${esc(subjectArg)} mistakes — across both OEQ and MCQ — and four blind spots stand out: ${(() => {
          const names = report.patterns.map(p => `<strong>${esc(p.name)}</strong>`);
          if (names.length === 0) return "";
          if (names.length === 1) return names[0];
          if (names.length === 2) return `${names[0]} and ${names[1]}`;
          return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
        })()}. Mastering answering techniques to fix these blind spots — alongside topical practice — would have boosted ${esc(childFirst)}'s ${esc(subjectArg)} score from <strong>${subjectAvgPct}%</strong> to <strong>${boostedScorePct}%</strong>!
      </p>
    </div>
    <p style="margin:0 0 22px 0;color:#43474f;font-size:14.5px;line-height:1.6;">
      ${esc(childFirst)} has lost <strong>${totalSubjectMarksLost}</strong> marks across <strong>${totalSubjectMarksAvailable}</strong> marks of assignments.${totalRepeatMarksLost > 0 ? ` In <strong>${totalRepeatMarksLost}</strong> marks lost, ${esc(childFirst)} even made the same mistake twice.` : ""} <strong>FOUR patterns</strong> account for <strong>${top4MarksLost}</strong> of those <strong>${totalSubjectMarksLost}</strong> marks.
    </p>

    <h2 style="margin:24px 0 4px 0;color:#001e40;font-size:18px;font-weight:800;letter-spacing:0.3px;">TOP FOUR PATTERNS OF MISTAKES</h2>
    ${patternsBlock}

    ${otherCount > 0 ? `<p style="margin:12px 0 0 0;color:#737780;font-size:12px;font-style:italic;">A further ${otherCount} mistakes (${otherMarksLost} marks lost) didn't fit any of the top 4 patterns — scattered one-offs.</p>` : ""}

    <div style="margin:32px 0 8px 0;padding:24px;border-radius:14px;background:linear-gradient(135deg,#003366 0%,#5b21b6 100%);text-align:center;">
      <p style="margin:0 0 16px 0;color:#ffffff;font-size:15px;line-height:1.55;">
        Would you like me to generate a <strong>personalised quiz (with guidance)</strong> for ${esc(childFirst)} to practice these answering techniques?
      </p>
      <a href="#" style="display:inline-block;padding:12px 28px;background:#ffffff;color:#003366;text-decoration:none;border-radius:999px;font-weight:800;font-size:14px;letter-spacing:0.2px;">
        Generate Personal Quiz →
      </a>
    </div>

    <p style="margin:24px 0 6px 0;color:#737780;font-size:11px;line-height:1.5;">
      This report was generated by reviewing every marked question across ${esc(childFirst)}'s ${esc(subjectArg)} papers.
      Patterns are surfaced from the actual marker notes and MCQ option analysis — no taxonomy was pre-defined.
    </p>
    <p style="margin:6px 0 0 0;color:#737780;font-size:12px;">— The MarkForYou team</p>
  </div>
</body></html>`;

  const outPath = path.join(evalDir, `unified-diagnosis-${safeStu}-${subjectLower}.html`);
  writeFileSync(outPath, html);
  console.log(`\nWrote: ${outPath}`);
  const totalRunCost = flashCost + proCost;
  console.log(`Total cost this run: ~$${totalRunCost.toFixed(4)} (Flash-Lite: $${flashCost.toFixed(4)}, Pro: $${proCost.toFixed(4)})`);
  console.log(`Total wall-clock: ${((Date.now() - t0run) / 1000).toFixed(1)}s`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
