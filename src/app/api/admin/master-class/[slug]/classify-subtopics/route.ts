import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { generateContentWithRetry } from "@/lib/gemini";
import { getMasterClass } from "@/data/master-class";

// POST /api/admin/master-class/[slug]/classify-subtopics?force=1
//
// Classifies every master-bank question whose syllabusTopic matches
// the Master Class's topicLabel into one of the sub-topic IDs defined
// in the Master Class content. Saves the result on examQuestion.subTopic.
//
// By default skips questions that already have a subTopic set —
// pass ?force=1 to reclassify every question.
//
// Returns a per-id count summary so the admin UI can render
// distribution after the run.

export async function POST(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { name: true, settings: true },
  });
  if (!isAdmin(me)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { slug } = await context.params;
  const content = getMasterClass(slug);
  if (!content) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });

  const force = req.nextUrl.searchParams.get("force") === "1";

  const questions = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { equals: content.topicLabel, mode: "insensitive" },
      transcribedStem: { not: null },
      examPaper: { sourceExamId: null, paperType: null },
      ...(force ? {} : { subTopic: null }),
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
    },
  });

  const subTopics = content.subTopics ?? [];
  const validIds = new Set(subTopics.map(t => t.id));

  // Prompt the model with the full sub-topic taxonomy and ask it to
  // pick the BEST match for each question. Returning JSON keyed by
  // questionId so we can update in a single pass.
  const taxonomy = subTopics
    .map(t => `  • ${t.id}: ${t.description}`)
    .join("\n");

  function questionToLine(q: typeof questions[number], idx: number): string {
    const opts = Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4
      ? `\n    Options: ${(q.transcribedOptions as string[]).map((o, i) => `(${i + 1}) ${o}`).join(" / ")}`
      : "";
    const answer = q.answer ? `\n    Answer: ${q.answer.slice(0, 200)}` : "";
    return `${idx + 1}. id=${q.id}  (Q${q.questionNum})\n    Stem: ${(q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 360)}${opts}${answer}`;
  }

  // Batch in groups of 8 to keep prompts under control + parallelise.
  const BATCH = 8;
  const updates: Array<{ id: string; subTopic: string }> = [];
  const unclassified: string[] = [];
  let processed = 0;

  for (let b = 0; b < questions.length; b += BATCH) {
    const batch = questions.slice(b, b + BATCH);
    const prompt = `You are tagging Singapore PSLE Science questions by sub-topic.

All questions below test the topic "${content.topicLabel}". Pick the ONE best sub-topic from the taxonomy for each question.

TAXONOMY:
${taxonomy}

RULES:
- Pick exactly ONE id per question — the one that best matches what the question is primarily testing.
- If a question seems to span two sub-topics, pick the dominant one (the harder concept the student needs to know to answer correctly).
- IF a question is PURELY a definition recall ("What is a population?", "Which term describes a group of grasshoppers?") with no other concept being tested, return the value "null" (string) for that question id — definitions are intentionally not a sub-topic because they almost always appear as a 1-mark sub-part inside a bigger OEQ on another concept.
- Return JSON ONLY: a map of question id → sub-topic id (or "null").

QUESTIONS:
${batch.map((q, i) => questionToLine(q, i)).join("\n\n")}

Return ONLY valid JSON of the form:
{ "<questionId>": "<sub-topic-id>", ... }`;

    try {
      const res = await generateContentWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      }, 1, 3000, `classify-subtopics:${slug}:${b}`);
      const text = (res.text ?? "").trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        for (const q of batch) unclassified.push(q.id);
        continue;
      }
      const parsed = JSON.parse(m[0]) as Record<string, string>;
      for (const q of batch) {
        const tag = parsed[q.id];
        if (tag === "null" || tag === null || tag === undefined) {
          // Purely a definition recall — intentionally left unclassified.
          continue;
        }
        if (validIds.has(tag)) updates.push({ id: q.id, subTopic: tag });
        else unclassified.push(q.id);
      }
    } catch (err) {
      console.error(`[classify-subtopics] batch ${b} failed:`, err);
      for (const q of batch) unclassified.push(q.id);
    }
    processed += batch.length;
  }

  // Write back in parallel.
  await Promise.all(updates.map(u =>
    prisma.examQuestion.update({ where: { id: u.id }, data: { subTopic: u.subTopic } }),
  ));

  // Distribution summary.
  const counts: Record<string, number> = {};
  for (const u of updates) counts[u.subTopic] = (counts[u.subTopic] ?? 0) + 1;

  return NextResponse.json({
    totalCandidates: questions.length,
    classified: updates.length,
    unclassified: unclassified.length,
    distribution: counts,
    unclassifiedIds: unclassified.slice(0, 20),  // first 20 for spot-check
  });
}
