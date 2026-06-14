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
  console.error("Usage: <studentName> <subject> [--refresh]");
  process.exit(1);
}
const forceRefresh = rest.includes("--refresh");

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

  const prompt = `You are an experienced primary-school tutor producing a personalised diagnosis for ONE student in ${subjectArg}. Below are every question this student got partially or fully wrong (${wrongs.length} records total: ${wrongOeq.length} open-ended + ${wrongMcq.length} multiple-choice). For OEQ records you have the marker's analytical notes. For MCQ records you have the options, the student's pick, the correct pick, and the AI-generated explanation of the correct answer.

Identify the TOP 4 RECURRING ERROR PATTERNS that may span both formats. DO NOT pre-define a taxonomy — let patterns emerge. Patterns describing HOW/WHY the student loses marks (e.g. "Stops one step short before stating the final consequence", "Misses negation words like 'not' or 'except'") are stronger than topic-specific ones.

THEN classify EVERY record [1..${wrongs.length}] into exactly one of the 4 patterns (patternIndex 0-3). Records that don't fit → patternIndex -1.

For each pattern provide:
  name — short vivid label (3-6 words)
  what — one sentence describing the pattern
  specific_examples — 3 examples (pick from records classified into this pattern, prefer a MIX of OEQ and MCQ when both formats are present). Each:
    questionRef — e.g. "[49]"
    type — "oeq" or "mcq"
    whatWentWrong — one sentence diagnosis (concise, parent-readable)
  strategic_advice — advice keyed to question-stem TRIGGER WORDS, not topic. E.g. "When you see 'explain why', always include a 'so that...' clause showing the final consequence." 2-4 sentences. WRAP KEY PHRASES IN **double-asterisk markdown** to render bold.
  trigger_keywords — question-stem phrases that flag this pattern

OUTPUT STRICT JSON:
{
  "patterns": [
    { "name": "...", "what": "...", "specific_examples": [...], "strategic_advice": "...", "trigger_keywords": [...] }
  ],
  "classification": [ { "idx": 1, "patternIndex": 0 }, ... ]
}

Classification array MUST have exactly ${wrongs.length} entries.${repeatBlock}

DATA:

${records}`;

  console.log(`\nPrompt size: ${(prompt.length / 1000).toFixed(1)}K chars (~${Math.round(prompt.length / 4 / 1000)}K tokens)`);

  const safeStu = student.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const cachePath = path.join(evalDir, `unified-diagnosis-${safeStu}-${subjectArg.toLowerCase()}.gemini-cache.json`);

  type Example = { questionRef: string; type: "oeq" | "mcq"; whatWentWrong: string };
  type Pattern = { name: string; what: string; specific_examples: Example[]; strategic_advice: string; trigger_keywords: string[] };
  type Classification = { idx: number; patternIndex: number };
  type Report = { patterns: Pattern[]; classification: Classification[] };

  let report: Report;
  let proCost = 0;
  if (!forceRefresh && existsSync(cachePath)) {
    console.log(`Using cached Pro analysis (${cachePath}). Pass --refresh to force.`);
    report = JSON.parse(readFileSync(cachePath, "utf8"));
  } else {
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
  const childFirst = (student.name ?? "").trim().split(/\s+/)[0] ?? student.name;
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
