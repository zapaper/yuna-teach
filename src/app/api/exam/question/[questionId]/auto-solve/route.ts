import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";
import { isAuthorizedForUsers } from "@/lib/access";

// Auto-solve a question whose answer key is missing or partial.
// Triggered automatically by the review page when it detects that
// a sub-part has no expected answer parsed from the stored
// `answer` field.
//
// Why an endpoint instead of a button: the user explicitly wants
// catch-all auto-solving — students/parents shouldn't have to
// notice the gap and click anything. The page detects the gap on
// load and fires this in the background.
//
// Idempotency: server checks whether every sub-part label is
// already present in `answer` and short-circuits if so. The client
// applies the same check before triggering, so the typical hit
// returns 200 with cached:false on first fire and 200 with
// cached:true on accidental retries.

export const maxDuration = 90;

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY ?? "",
  httpOptions: { timeout: 80_000 },
});

// Prompt mirrors /api/admin/answer-steps but always emits a
// per-subpart labelled answer. For single-part questions we
// emit "(a) Steps: ... Final answer: ..." anyway — the
// review page parses it identically and shows just one block.
const SOLVE_PROMPT = `You are a Singapore primary-school maths/science teacher writing answer keys.

Solve the question below. Show concise step-by-step working.

Output rules:
- For EACH sub-part, emit a labelled block in the form:
    (LABEL) Steps: Step 1: ... | Step 2: ... | ... | Final answer: ...
- Each step on its own clause separated by " | " (NOT a literal newline).
- Each step is ONE short sentence, max ~20 words, including the actual calculation.
- Total steps usually 2–6 per sub-part.
- "Final answer:" line gives the numeric/short answer with units if relevant.
- Concatenate all sub-part blocks separated by " | " — so for parts (a), (b), (c) the full output looks like:
    (a) Steps: ... Final answer: ... | (b) Steps: ... Final answer: ... | (c) Steps: ... Final answer: ...
- If the question has NO sub-parts, label it "(a)" anyway.

LaTeX math (CRITICAL):
- Wrap fractions, mixed numbers, exponents, square roots, and any
  layout-dependent math in single dollar signs so the renderer
  stacks them properly. Examples:
    proper fraction:   $\\frac{7}{27}$    (NOT 7/27)
    mixed number:      $4\\frac{5}{6}$    (NOT 4 5/6)
    exponent:          $5^2$              (NOT 5^2 or 5²)
    square root:       $\\sqrt{16}$        (NOT √16)
- Plain integers, decimals, percentages, currency, and units stay
  as-is — no need to wrap "324" or "$4.20" or "12 cm" in LaTeX.

Return ONLY valid JSON:
{ "answer": "(a) Steps: ... | (b) Steps: ..." }`;

type AiOut = { answer: string };

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ questionId: string }> },
): Promise<Response> {
  const { questionId } = await params;
  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      questionNum: true,
      answer: true,
      transcribedStem: true,
      transcribedSubparts: true,
      transcribedOptions: true,
      diagramImageData: true,
      examPaper: {
        select: {
          userId: true,
          assignedToId: true,
          subject: true,
          sourceExamId: true, // master paper id, when this paper is a clone
        },
      },
    },
  });
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  // Authorization: same rule as the review-page layout — paper
  // owner, assigned student, or admin can trigger solving.
  const auth = await isAuthorizedForUsers([q.examPaper.userId, q.examPaper.assignedToId]);
  if (!auth.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Build the prompt content. Subparts shape: [{label, text, answer?}].
  type Subpart = { label: string; text: string };
  const subparts: Subpart[] = Array.isArray(q.transcribedSubparts)
    ? (q.transcribedSubparts as Subpart[]).filter(
        (s) => s && typeof s.label === "string" && !s.label.startsWith("_") && typeof s.text === "string",
      )
    : [];

  // Idempotency: if every sub-part label is already mentioned in
  // the answer text, no gaps remain — return the existing answer.
  // Same check the client uses before firing, but enforced here too
  // so a stale/racy client trigger doesn't burn another AI call.
  //
  // Accept ALL the common encodings of compound labels — hyphenated
  // storage ("a-i") commonly lives in the answer field as "(a)(i)"
  // split-paren form. Without that second check, a perfectly-good
  // answer like "(a)(i) R, Q | (a)(ii) T, U" trips a re-solve every
  // page load AND re-flags the master question with the [solve on
  // demand] note.
  if (q.answer) {
    const ans = q.answer.toLowerCase();
    const labels = subparts.map((s) => s.label.toLowerCase());
    const labelPresent = (l: string): boolean => {
      if (ans.includes(`(${l})`)) return true;
      if (l.includes("-")) {
        const parenParen = "(" + l.split("-").join(")(") + ")";
        if (ans.includes(parenParen)) return true;
      }
      return false;
    };
    if (labels.length > 0 && labels.every(labelPresent)) {
      return NextResponse.json({ answer: q.answer, cached: true });
    }
  }
  const optList = Array.isArray(q.transcribedOptions)
    ? (q.transcribedOptions as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0)
    : [];

  const lines = [
    SOLVE_PROMPT,
    "",
    `Subject: ${q.examPaper.subject ?? "Mathematics"}`,
    `Question: ${q.transcribedStem ?? "(stem missing — solve from the diagram)"}`,
    ...(subparts.length > 0 ? subparts.map((s) => `(${s.label}) ${s.text}`) : []),
    ...(optList.length > 0 ? optList.map((o, i) => `Option (${i + 1}): ${o}`) : []),
    `Existing partial answer key (preserve any correct part): ${q.answer ?? "(none)"}`,
  ];

  type Part = { text: string } | { inlineData: { mimeType: "image/jpeg"; data: string } };
  const parts: Part[] = [{ text: lines.join("\n") }];
  if (q.diagramImageData) {
    const clean = q.diagramImageData.replace(/^data:image\/\w+;base64,/, "");
    parts.push({ inlineData: { mimeType: "image/jpeg", data: clean } });
  }

  let parsed: AiOut;
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    });
    const text = (resp.text ?? "").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(text) as AiOut;
    if (!parsed.answer) throw new Error("AI returned no answer");
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "AI call failed" },
      { status: 502 },
    );
  }

  // Write the labelled output. The "[solve on demand]" tag goes on
  // the master question's markingNotes (below) — not the answer
  // text — so end-users don't see internal markers.
  const newAnswer = parsed.answer;
  await prisma.examQuestion.update({
    where: { id: questionId },
    data: { answer: newAnswer },
  });

  // Also flag the corresponding MASTER question with a "solve on
  // demand" note. The student/parent already has a working answer
  // on this clone, but the underlying extraction gap on the master
  // needs an admin to fix it (re-OCR the answer page, edit the
  // master's answer field, etc.) so future clones don't have to
  // re-pay the AI cost.
  //
  // If we're already looking at the master (sourceExamId is null),
  // flag the row directly.
  const masterPaperId = q.examPaper.sourceExamId ?? null;
  const masterQuery = masterPaperId
    ? { examPaperId: masterPaperId, questionNum: q.questionNum }
    : null;
  if (masterQuery) {
    const master = await prisma.examQuestion.findFirst({
      where: masterQuery,
      select: { id: true, flagged: true, markingNotes: true },
    });
    if (master && !master.flagged) {
      await prisma.examQuestion.update({
        where: { id: master.id },
        data: {
          flagged: true,
          flaggedAt: new Date(),
          markingNotes:
            `[solve on demand] Answer key was missing or partial — AI auto-solved on the clone. ` +
            `Re-extract the answer from the original PDF or hand-edit the master's answer field.` +
            (master.markingNotes ? `\n\nPrevious notes:\n${master.markingNotes}` : ""),
        },
      });
    }
  } else {
    // Looking at the master directly — flag this row.
    await prisma.examQuestion.update({
      where: { id: questionId },
      data: {
        flagged: true,
        flaggedAt: new Date(),
        markingNotes:
          `[solve on demand] Answer key was missing or partial — AI auto-solved. ` +
          `Re-extract from the original PDF or hand-edit the answer field.`,
      },
    });
  }

  return NextResponse.json({ answer: newAnswer, cached: false });
}
