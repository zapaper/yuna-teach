import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { generateContentWithRetry } from "@/lib/gemini";

// POST { questionId } → asks Gemini to rewrite the answer key in the
// standard "(a) ... | (b) ... | (c) ..." (or compound "(a)(i) ...")
// format that parsePartAnswers understands. Returns { proposed }
// WITHOUT saving — admin reviews and saves via PATCH /exam/questions.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { questionId } = await request.json();
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });

  const q = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: {
      questionNum: true, answer: true, transcribedSubparts: true, transcribedStem: true,
    },
  });
  if (!q || !q.answer) return NextResponse.json({ error: "Question has no answer to normalise" }, { status: 404 });

  const subs = q.transcribedSubparts as Array<{ label: string; text?: string }> | null;
  const subpartList = subs && subs.length > 0
    ? subs.map(s => `  - "${s.label}": ${(s.text ?? "").slice(0, 120)}`).join("\n")
    : "(no subparts on file — infer from the answer text)";

  const prompt = `You are normalising an exam-answer-key string so a deterministic parser can split it into per-part answers. The parser expects this canonical structure:

  STANDARD FORMAT:
    (a) <answer for part a> | (b) <answer for part b> | (c) <answer for part c>

  COMPOUND PARTS (with roman sub-labels):
    (a)(i) <text> | (a)(ii) <text> | (b)(i) <text> | (b)(ii) <text>

  Rules for rewriting:
  - Replace any of these with the canonical form:
      "a)" / "b)"           → "(a)" / "(b)"
      "ai)" / "aii)"        → "(a)(i)" / "(a)(ii)"
      "a)i)" / "a)ii)"      → "(a)(i)" / "(a)(ii)"
      "Part a)" / "Part b)" → "(a)" / "(b)"
      "Part a)i)"           → "(a)(i)"
      "<N>a:" / "<N>b:"     → "(a)" / "(b)"   (strip leading question number like "7a")
      "i)" / "ii)" as the TOP-LEVEL parts → "(a)(i)" / "(a)(ii)" ONLY when subparts confirm a compound structure; otherwise keep as standalone parts only if the subparts list says so.
  - Use " | " (space, pipe, space) BETWEEN parts. NEVER inside a part's answer text — pick a different connector (e.g. semicolon, " and ", comma) if the original used "|" inside a part.
  - Keep WITHIN-part content untouched: "/" between alternatives (e.g. "lung / lungs") stays; sentence wording stays; LaTeX stays.
  - If the answer is just "See answer image" or similar with no per-part text, return it unchanged.
  - Output ONLY the rewritten answer string. No JSON, no markdown, no quotes around it, no explanation.

Subparts on file for this question (use these labels as the target part labels):
${subpartList}

Question number: ${q.questionNum}
Original answer:
${q.answer}

Rewritten answer (canonical format only, single line):`;

  try {
    const response = await generateContentWithRetry({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0 },
    });
    const proposed = (response.text ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
    return NextResponse.json({ proposed, original: q.answer });
  } catch (err) {
    console.error("[broken-questions/propose-answer] failed", err);
    return NextResponse.json({ error: "Proposal failed" }, { status: 500 });
  }
}
