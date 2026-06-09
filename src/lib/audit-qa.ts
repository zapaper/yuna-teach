// AI audit of Q&A answer keys after clean extraction.
// Writes a map of questionId -> reason into paper.metadata.auditFlags so the
// admin edit view can render the flagged questions in red.

import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";

type AuditFlags = Record<string, string>;

function briefStem(s: string | null, max = 500): string {
  if (!s) return "";
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function formatOptions(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw.map((o, i) => `  (${i + 1}) ${String(o)}`).join("\n");
}

function formatSubparts(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .filter((sp): sp is { label: string; text: string } => !!sp && typeof sp === "object" && "label" in sp && !String((sp as { label: string }).label).startsWith("_"))
    .map(sp => `  (${sp.label}) ${sp.text}`)
    .join("\n");
}

function isPassageBound(topic: string | null | undefined): boolean {
  const t = (topic ?? "").toLowerCase();
  return t.includes("grammar cloze") || t.includes("editing") ||
    (t.includes("comprehension") && t.includes("cloze"));
}

/** Audit English Q&A for a paper. Returns a map of questionId → reason. */
export async function auditEnglishPaper(paperId: string): Promise<AuditFlags> {
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    include: { questions: { orderBy: { orderIndex: "asc" } } },
  });
  if (!paper) return {};

  const flags: AuditFlags = {};

  // --- Standalone questions (Grammar MCQ, Vocab MCQ, Synthesis, Vocab Cloze MCQ, Visual Text MCQ) ---
  const standalone = paper.questions.filter(q => !isPassageBound(q.syllabusTopic) && !(q.syllabusTopic ?? "").toLowerCase().includes("comprehension") && q.answer && q.transcribedStem);

  const BATCH = 10;
  for (let i = 0; i < standalone.length; i += BATCH) {
    const batch = standalone.slice(i, i + BATCH);
    const items = batch.map((q, j) => {
      const opts = formatOptions(q.transcribedOptions);
      const subs = formatSubparts(q.transcribedSubparts);
      return [
        `[${j}] id=${q.id}`,
        `Topic: ${q.syllabusTopic}`,
        `Stem: ${briefStem(q.transcribedStem)}`,
        opts ? `Options:\n${opts}` : "",
        subs ? `Sub-parts:\n${subs}` : "",
        `Answer key: ${q.answer}`,
      ].filter(Boolean).join("\n");
    }).join("\n\n---\n\n");

    const prompt = `You are auditing primary-school English answer keys. Flag ONLY clear mismatches (wrong grammar, wrong tense, meaningless word, wrong option number, name/spelling mismatch between stem and answer). Be lenient on minor style differences.

For Grammar/Vocab/Visual-Text MCQ, answer is 1|2|3|4. For Synthesis, answer is the rewritten sentence.

Return ONLY JSON: {"issues":[{"idx":N,"id":"<id>","reason":"<one sentence>"}]}
If all ok: {"issues":[]}

Items:
${items}`;

    try {
      const resp = await generateContentWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0 },
      });
      const parsed = JSON.parse(resp.text ?? "{}") as { issues?: { idx: number; id: string; reason: string }[] };
      for (const iss of (parsed.issues ?? [])) {
        const qid = iss.id || batch[iss.idx]?.id;
        if (qid) flags[qid] = iss.reason;
      }
    } catch (err) {
      console.warn(`[audit-english] Standalone batch ${i} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // --- Passage-bound (Grammar Cloze, Editing, Comp Cloze) — one call per section with shared passage ---
  const passageBound = paper.questions.filter(q => isPassageBound(q.syllabusTopic) && q.answer);
  const bySection: Record<string, typeof passageBound> = {};
  for (const q of passageBound) {
    const key = q.syllabusTopic ?? "Other";
    (bySection[key] ??= []).push(q);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (paper.metadata ?? {}) as any;
  const sectionOcrTexts = meta.sectionOcrTexts ?? {};

  for (const [secName, qs] of Object.entries(bySection)) {
    let passage = "";
    const first = qs[0];
    const subs = first.transcribedSubparts as Array<{ label: string; text: string }> | null;
    passage = subs?.find(s => s.label === "_passage")?.text ?? "";
    if (!passage) {
      const hit = Object.entries(sectionOcrTexts).find(([k]) =>
        (k as string).toLowerCase().replace(/\s+/g, "") === secName.toLowerCase().replace(/\s+/g, "")
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (hit) passage = (((hit[1] as any)?.ocrText ?? "") as string);
    }
    if (!passage) continue;

    const list = qs.map(q => `  Q${q.questionNum}: answer key = ${q.answer}`).join("\n");
    const prompt = `Audit these passage-bound English answer keys against the shared passage.

Section: ${secName}

PASSAGE (numbered blanks appear inline as (N) or **(N) word**):
${passage.slice(0, 4000)}

QUESTIONS:
${list}

For each, judge whether the answer key is grammatically and semantically correct for the blank. Flag clear mismatches only. For Editing, the answer is the CORRECTED word replacing an error.

Return ONLY JSON: {"issues":[{"questionNum":"N","reason":"<one sentence>"}]}
If all ok: {"issues":[]}`;

    try {
      const resp = await generateContentWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0 },
      });
      const parsed = JSON.parse(resp.text ?? "{}") as { issues?: { questionNum: string; reason: string }[] };
      for (const iss of (parsed.issues ?? [])) {
        const row = qs.find(r => r.questionNum === String(iss.questionNum));
        if (row) flags[row.id] = iss.reason;
      }
    } catch (err) {
      console.warn(`[audit-english] Passage section ${secName} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Write flags back to paper metadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newMeta = { ...(paper.metadata as any ?? {}), auditFlags: flags };
  await prisma.examPaper.update({
    where: { id: paperId },
    data: { metadata: newMeta },
  });
  console.log(`[audit-english] Paper ${paperId}: ${Object.keys(flags).length} Q&A flagged`);
  return flags;
}

/** Audit Science Q&A for a paper. Returns a map of questionId → reason. */
export async function auditSciencePaper(paperId: string): Promise<AuditFlags> {
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    include: { questions: { orderBy: { orderIndex: "asc" } } },
  });
  if (!paper) return {};

  const flags: AuditFlags = {};
  const qs = paper.questions.filter(q => q.transcribedStem && q.answer);
  const BATCH = 8;
  for (let i = 0; i < qs.length; i += BATCH) {
    const batch = qs.slice(i, i + BATCH);
    const items = batch.map((q, j) => {
      const opts = formatOptions(q.transcribedOptions);
      const subs = formatSubparts(q.transcribedSubparts);
      const isMcq = !!opts;
      return [
        `[${j}] id=${q.id}`,
        `Type: ${isMcq ? "MCQ" : "OEQ"}`,
        `Topic: ${q.syllabusTopic}`,
        `Stem: ${briefStem(q.transcribedStem)}`,
        opts ? `Options:\n${opts}` : "",
        subs ? `Sub-parts:\n${subs}` : "",
        `Answer key: ${q.answer}`,
      ].filter(Boolean).join("\n");
    }).join("\n\n---\n\n");

    const prompt = `You are auditing Singapore primary-school Science answer keys. You see the TEXT of each question — diagrams, option images, tables and graphs are shown to the STUDENT separately and are NOT visible to you.

IMPORTANT — do NOT flag any of the following as problems:
- "diagram missing", "graph missing", "table missing", "flowchart missing" — those are shown as images to the student
- "options missing" when the Type is MCQ — the option text is stored separately and the student sees it
- An MCQ stem that ends with "Which of the following…" and no visible options — the options exist, just not in this audit view
- Stems that reference labelled diagrams (e.g. "at position X", "organism Q") — the diagram is shown to the student
- Minor wording / spelling in OEQ answers, or multiple valid phrasings of the same scientific point

Flag ONLY clear scientific or logical mismatches:
- OEQ answer contradicts basic Primary-school science principles or doesn't address what the stem asks
- OEQ answer contains an internal contradiction or a self-refuting statement
- Answer key is labelled for a different sub-part than the question asks (e.g. "(c)" when the question is "(b)")
- Answer key contains a different name or entity than the stem (copy-paste error)
- MCQ answer that is clearly scientifically wrong, judging by the question text alone (not the options)
- Answer key uses a format the question does NOT ask for (e.g. list of parts when asked for an arrow diagram)

Return ONLY JSON: {"issues":[{"idx":N,"id":"<id>","reason":"<one sentence>"}]}
If all ok: {"issues":[]}

Items:
${items}`;

    try {
      const resp = await generateContentWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0 },
      });
      const parsed = JSON.parse(resp.text ?? "{}") as { issues?: { idx: number; id: string; reason: string }[] };
      for (const iss of (parsed.issues ?? [])) {
        const qid = iss.id || batch[iss.idx]?.id;
        if (qid) flags[qid] = iss.reason;
      }
    } catch (err) {
      console.warn(`[audit-science] Batch ${i} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newMeta = { ...(paper.metadata as any ?? {}), auditFlags: flags };
  await prisma.examPaper.update({
    where: { id: paperId },
    data: { metadata: newMeta },
  });
  console.log(`[audit-science] Paper ${paperId}: ${Object.keys(flags).length} Q&A flagged`);
  return flags;
}

/** Audit Chinese Q&A — phrase-rubric OEQs + 短文填空 / 完成对话 MCQ keys. */
export async function auditChinesePaper(paperId: string): Promise<AuditFlags> {
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    include: { questions: { orderBy: { orderIndex: "asc" } } },
  });
  if (!paper) return {};

  const flags: AuditFlags = {};
  const qs = paper.questions.filter(q => q.transcribedStem && q.answer);
  // Smaller batch than English/Science — Chinese stems run long
  // (passages live in the stem) and a 10-item batch was overflowing
  // gemini-2.5-flash's context window in practice.
  const BATCH = 6;
  for (let i = 0; i < qs.length; i += BATCH) {
    const batch = qs.slice(i, i + BATCH);
    const items = batch.map((q, j) => {
      const opts = formatOptions(q.transcribedOptions);
      const subs = formatSubparts(q.transcribedSubparts);
      const isMcq = !!opts;
      return [
        `[${j}] id=${q.id}  qNum=${q.questionNum}`,
        `Type: ${isMcq ? "MCQ" : "OEQ"}`,
        `Topic: ${q.syllabusTopic}`,
        `Stem: ${briefStem(q.transcribedStem, 800)}`,
        opts ? `Options:\n${opts}` : "",
        subs ? `Sub-parts:\n${subs}` : "",
        `Answer key: ${q.answer}`,
      ].filter(Boolean).join("\n");
    }).join("\n\n---\n\n");

    const prompt = `You are auditing Singapore primary-school 华文 (Chinese) answer keys. The TEXT of each question's stem, options (for MCQ), sub-parts, and the answer key are all shown to you. READ THEM CAREFULLY and reason about whether the answer actually makes sense for the question — not just whether it's formatted correctly.

IMPORTANT — do NOT flag any of the following:
- "diagram missing", "passage missing", "image missing" — those are shown separately to the student. If you can't see the full 短文 / 对话 passage in the stem, assume it exists.
- Multiple valid phrasings of the same Chinese answer — phrase-based rubrics deliberately list one acceptable phrasing per scoring point.
- The answer key being in 简体 vs 繁体 — both forms are acceptable.
- Stylistic differences in OEQ (e.g. the key uses 而 instead of 但是) — only flag clear semantic or factual mismatches.
- Any question whose Topic is "阅读理解 OEQ" (or contains 阅读理解 AND the Type is OEQ) — the answer key for these is entered from a separate answer sheet, so the stem we see may be incomplete or just a question prompt. Do NOT flag a Comp OEQ for "answer doesn't address the stem", "answer is just phrases without context", or similar — output an empty issues list for these unless the answer is BLANK or contains an obvious copy-paste error from a different question. (Q33 应用文 is the exception — keep auditing Q33 normally per its own rule below.)

ROUTING — read the question's "Topic:" line FIRST and route to the matching rule below. The "Type:" line ("MCQ" / "OEQ") is auto-derived from whether transcribedOptions is populated; for 短文填空 and 完成对话 the Type may say "OEQ" even though both are choose-from-a-list sections — TRUST the Topic, not the Type. Do NOT apply the OEQ phrase rubric to a 短文填空 / 完成对话 question.

DO read the stem and option text together when judging an MCQ answer:

- 短文填空 (Passage Cloze) MCQ — the stem is a sentence with a numbered blank "(N)". The four options are short words/phrases. READ the option whose number matches the answer key, INSERT it into the blank, and check whether the resulting sentence is grammatically correct AND contextually consistent with the surrounding sentence. Flag when the chosen option produces a clearly ungrammatical, contradictory, or out-of-context sentence (e.g. wrong tense, opposite meaning, or a noun where a verb is needed). Sanity-check that the answer is in the 1-4 range too.

- 完成对话 (Dialogue Cloze) MCQ — IMPORTANT FORMAT NOTE: the answer key for every 完成对话 question is a SINGLE DIGIT (typically 1-8) pointing to a printed word bank that lists 8 short phrases. The answer key is NEVER the phrase text itself; it is ALWAYS just the digit. Do NOT flag a 完成对话 question merely because its answer is a digit instead of a phrase — that is the expected format. To audit a 完成对话 question: look at the printed word bank, identify which phrase corresponds to the digit in the answer key, mentally INSERT that phrase into the dialogue's numbered blank, and check whether the speaker's line still flows, addresses the previous turn, and makes the conversation coherent. Flag only when (a) the digit is outside the printed word-bank range (e.g. "9" when the bank has 8 entries), or (b) inserting the corresponding phrase produces an obvious non-sequitur the speaker would never say in context.

- General MCQ — the chosen option's TEXT must actually answer what the stem ASKS for (e.g. if the stem asks for a 同义词 of "高兴", the chosen option must mean 高兴; if the stem asks for the speaker's mood, the chosen option must reflect that mood).

DO read OEQ answer keys against the question stem:

- OEQ phrase rubric — when the key uses " | " separators, EACH separated phrase should describe a real, distinct scoring point that DIRECTLY answers the question being asked. Flag when the phrases are commentary like 评分标准 / 注释 instead of scoring points, or when the phrases together don't actually address the question (e.g. stem asks "为什么", but the phrases describe "什么是").

- Q33 应用文 (letter / 邮件 / 通告 writing) — the answer key should be a sample letter that addresses EVERY W the stem explicitly asks for (when, where, why, who…). A "(评分标准: 内容X分; 语言Y分)" annotation is OPTIONAL — when the key omits it, assume the standard split of 2 marks 内容 + 2 marks 语言 and do NOT flag the missing annotation. Flag only when the sample letter is missing a W that the stem clearly requires, OR when an explicit 评分标准 annotation IS present but its X+Y sum doesn't equal marksAvailable.

- Q40 你同意吗 / opinion question — the answer should include a 立场 (agree / disagree), at least two reasons, and a closing. Flag if the key has no clear stance, fewer than two reasons, or a stance that contradicts what the passage implies.

- Sub-part label mismatches (e.g. key labelled "(乙)" on a "(甲)" question) — flag.

- Answer key contains a different name / entity / topic than the stem (copy-paste error from a sibling question) — flag.

Return ONLY JSON: {"issues":[{"idx":N,"id":"<id>","reason":"<one sentence in Chinese>"}]}
If all ok: {"issues":[]}

Items:
${items}`;

    try {
      const resp = await generateContentWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0 },
      });
      const parsed = JSON.parse(resp.text ?? "{}") as { issues?: { idx: number; id: string; reason: string }[] };
      for (const iss of (parsed.issues ?? [])) {
        const qid = iss.id || batch[iss.idx]?.id;
        if (qid) flags[qid] = iss.reason;
      }
    } catch (err) {
      console.warn(`[audit-chinese] Batch ${i} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newMeta = { ...(paper.metadata as any ?? {}), auditFlags: flags };
  await prisma.examPaper.update({
    where: { id: paperId },
    data: { metadata: newMeta },
  });
  console.log(`[audit-chinese] Paper ${paperId}: ${Object.keys(flags).length} Q&A flagged`);
  return flags;
}

/** Dispatch the right audit based on paper subject. Fire-and-forget friendly. */
export async function auditPaper(paperId: string): Promise<AuditFlags> {
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: { subject: true },
  });
  if (!paper) return {};
  const subj = (paper.subject ?? "").toLowerCase();
  const raw = paper.subject ?? "";
  if (subj.includes("english")) return auditEnglishPaper(paperId);
  if (subj.includes("science")) return auditSciencePaper(paperId);
  // Chinese routing: same convention used elsewhere in the codebase —
  // also catches 华文 / 中文 / 华语 strings stored as the subject.
  if (subj.includes("chinese") || raw.includes("华文") || raw.includes("中文") || raw.includes("华语")) {
    return auditChinesePaper(paperId);
  }
  return {};
}
