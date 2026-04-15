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

/** Dispatch the right audit based on paper subject. Fire-and-forget friendly. */
export async function auditPaper(paperId: string): Promise<AuditFlags> {
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: { subject: true },
  });
  if (!paper) return {};
  const subj = (paper.subject ?? "").toLowerCase();
  if (subj.includes("english")) return auditEnglishPaper(paperId);
  if (subj.includes("science")) return auditSciencePaper(paperId);
  return {};
}
