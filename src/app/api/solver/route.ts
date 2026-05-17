import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { mathHeuristicsBlock } from "@/lib/math-heuristics";

export const maxDuration = 180;

// Result rows stick around for 15 min so a client that backgrounded its tab
// mid-solve can reconnect and pick up its result. Cleanup runs
// opportunistically on each new POST.
const JOB_TTL_MS = 15 * 60 * 1000;

function getAI() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY!,
    httpOptions: { timeout: 170_000 },
  });
}

function loadTopics(filename: string): string[] {
  try {
    const filePath = path.join(process.cwd(), "data", filename);
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const MATH_TOPICS = loadTopics("math-topics.txt");
const SCIENCE_TOPICS = loadTopics("science-topics.txt");
const ENGLISH_TOPICS = loadTopics("english-topics.txt");

// Defensive cleanup for orphan LaTeX commands the AI emits despite
// the prompt's "no LaTeX commands except \\frac" rule. The model
// keeps shipping things like `60 \\times \\ 100 = \\$6000$` which
// neither MathText nor KaTeX can render — the user sees the literal
// backslash commands.
//
// These replacements are safe to apply globally:
//   - Inside a `$...$` math segment, KaTeX renders `\times` and the
//     Unicode `×` identically, so swapping is visually neutral.
//   - Outside math, the Unicode form is what we wanted anyway.
//
// `\$` always becomes a plain `$`. A leftover stray `$` after the
// substitution is harmless (MATH_SEGMENT_RE only matches `$...\command...$`
// — a lone `$` with no command between renders as currency text).
function sanitizeSolverSolution(s: string): string {
  if (!s) return s;
  return s
    .replace(/\\times\s*\\?\s*/g, "× ")
    .replace(/\\div\s*\\?\s*/g, "÷ ")
    .replace(/\\cdot\s*\\?\s*/g, "· ")
    .replace(/\\pm\s*\\?\s*/g, "± ")
    .replace(/\\approx\s*\\?\s*/g, "≈ ")
    .replace(/\\\$/g, "$")
    // `\,` and `\;` are LaTeX thin-spaces — become a plain space.
    .replace(/\\[,;:]/g, " ")
    // `\(` and `\)` are MathJax-style display delimiters — strip.
    .replace(/\\[()]/g, "")
    // Tidy any double-spaces left behind by the above.
    .replace(/ {2,}/g, " ");
}

// GET /api/solver?jobId=<uuid> — client reconnect path. Returns the saved
// result (or pending status) for a job the client previously POSTed.
export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  const job = await prisma.solverJob.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ status: "not_found" }, { status: 404 });
  if (job.status === "done") {
    return NextResponse.json({ status: "done", ...(job.result as Record<string, unknown>) });
  }
  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error ?? "Failed to solve" }, { status: 500 });
  }
  return NextResponse.json({ status: "pending" });
}

export async function POST(request: NextRequest) {
  console.log("[solver] route hit");
  const { imageBase64, hint, jobId } = await request.json();
  if (!imageBase64) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }
  if (!jobId || typeof jobId !== "string") {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  // Clean up stale jobs on the side.
  prisma.solverJob
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - JOB_TTL_MS) } } })
    .catch((e) => console.error("[solver] cleanup failed:", e));

  // If this jobId already has a saved result, return it (idempotent retry).
  const existing = await prisma.solverJob.findUnique({ where: { id: jobId } });
  if (existing?.status === "done" && existing.result) {
    console.log("[solver] returning cached result for", jobId);
    return NextResponse.json(existing.result);
  }
  if (existing?.status === "error") {
    return NextResponse.json({ error: existing.error ?? "Failed to solve" }, { status: 500 });
  }

  // Mark the job as pending. upsert so concurrent POSTs with the same jobId
  // (which shouldn't happen but might under retry races) don't crash.
  await prisma.solverJob.upsert({
    where: { id: jobId },
    create: { id: jobId, status: "pending" },
    update: { status: "pending", error: null, result: undefined },
  });

  const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");

  const prompt = `You are an expert primary school tutor. Analyse this question image and respond in JSON.

Steps:
1. Identify the subject: "Math", "Science", or "English".
2. Match to ONE topic from the exact list below. You MUST pick a topic from the list word-for-word, or return null if none fits.
   Math topics:
   ${MATH_TOPICS.map((t) => `- "${t}"`).join("\n   ")}
   Science topics:
   ${SCIENCE_TOPICS.map((t) => `- "${t}"`).join("\n   ")}
   English topics:
   ${ENGLISH_TOPICS.map((t) => `- "${t}"`).join("\n   ")}
3. If the question contains a geometric diagram (shapes, angles, circles, composite figures):
   a. PRIVATELY (as your internal reasoning, NOT in the output) describe every shape, all labelled angles/lengths/measurements and their spatial relationships.
   b. PRIVATELY identify how to break a composite area / circumference figure into simpler parts and note each part's measurements.
   c. In the "solution" field, jump STRAIGHT into the numbered working steps that use those simpler parts. DO NOT echo your diagram analysis to the student — the answer should read like a clean tutor explanation, not a scratch-pad.
4. Provide a clear, step-by-step solution suitable for a primary school student.
5. If the question involves ratio, fractions, percentages, or comparing/sharing quantities between people or groups, ALSO return a "diagrams" field — an array of Singapore model method bar diagram steps:
   [
     {
       "title": "<e.g. 'Step 1: Initial ratio' or 'Step 2: After transfer', or null for single-step>",
       "rows": [{ "label": "<name or quantity>", "units": <integer 1-10>, "value": "<known value, '?' if unknown, or null>" }],
       "unitValue": "<value of 1 unit if determinable, else null>"
     }
   ]
   Rules for diagrams:
   - Use MULTIPLE steps when the problem changes state (e.g. quantities transferred, ratios change across two stages) — show each state as its own diagram with a clear title.
   - For straightforward single-state problems, use one entry with title: null.
   - Each row = one person/quantity being compared.
   - "units" = the ratio or fraction number (e.g. ratio 3:5 → units 3 and 5).
   - "value" = the actual quantity if known/solved, "?" if the question asks for it, null if not relevant.
   - Optionally add a "Total" row if it helps understanding.
   - "unitValue" = value of 1 unit after solving.
   - Maximum 5 rows per step, units must be 1-20.
   For all other question types, set "diagrams": [].

${hint ? `Additional context from the user: ${hint}\n` : ""}Rules:
- topic must be copied EXACTLY from the list, or null if no match.
- Do NOT invent or paraphrase topic names.
- **Fractions MUST be written as inline LaTeX delimited by single dollar signs**. CRITICAL — your output is JSON, so backslashes inside string values MUST be DOUBLED: write \`$\\\\frac{3}{5}$\` (TWO backslashes) inside the "solution" string, not \`$\\frac{3}{5}$\`. The JSON parser will turn the doubled backslash back into one. Same for mixed numbers: \`$2\\\\frac{1}{4}$\`. If you forget to double the backslash, JSON parsing will eat \`\\f\` as a form-feed.
- **NO OTHER LATEX COMMANDS.** \\\\frac is the ONLY backslash-command you may emit. Specifically forbidden, even inside \`$...$\`:
    \\\\times — write × (multiply sign) directly
    \\\\div   — write ÷ directly
    \\\\cdot  — write · directly
    \\\\$     — write a plain $ (no backslash) for currency
    \\\\,     — just use a space
    \\\\      — never escape ANYTHING else
  Example of WHAT NOT TO DO: \`60 \\\\times \\\\ 100 = \\\\$6000$\`. Example of correct output: \`60 × 100 = $6000\`. Powers like x^2 stay as plain x^2. Currency stays plain ("$24", never "\\\\$24" and never wrapped in $...$).
- Use **double asterisks** to bold: step labels (e.g. **Step 1:**), the answer label (**Answer:**), and key subject terms (e.g. **numerator**, **photosynthesis**, **ratio**). No other markdown.
- Always end the solution with a blank line followed by a final line that starts exactly with "Answer: " and gives the concise final answer (e.g. "Answer: The total cost is $24." or "Answer: x = 5").
- For circle problems: use π = 22/7 unless the question specifies otherwise. Circumference = 2 x 22/7 x r. Area = 22/7 x r x r. Diameter = 2 x radius. Always state which value (radius or diameter) you are using.
- For composite area/circumference problems: first break the figure into simpler parts using imaginary lines (e.g. split into a semicircle + rectangle, or subtract a circle from a square). Calculate each part separately, then combine. Show each part as its own numbered step.
- For geometry: identify the shape clearly, state all given measurements, then apply the correct formula step by step.
${mathHeuristicsBlock()}

Respond with ONLY valid JSON (no markdown fences):
{
  "subject": "Math" or "Science" or "English",
  "topic": "<exact topic from list, or null>",
  "solution": "<step-by-step solution, use \\n for line breaks>",
  "diagrams": [{ "title": "...", "rows": [...], "unitValue": "..." }]
}`;

  try {
    console.log("[solver] calling Gemini");
    const response = await getAI().models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg" as const, data: base64Data } },
          { text: prompt },
        ],
      }],
      config: { temperature: 0.2 },
    });

    const text = (response.text ?? "").trim();
    const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(jsonStr);

    // Validate topic is actually in our list
    const allTopics = [...MATH_TOPICS, ...SCIENCE_TOPICS];
    const rawTopic: string | null = parsed.topic ?? null;
    const validTopic = rawTopic && allTopics.includes(rawTopic) ? rawTopic : null;

    // Validate diagrams array
    type RawRow = { label?: unknown; units?: unknown; value?: unknown };
    const rawDiagrams = Array.isArray(parsed.diagrams) ? parsed.diagrams : [];
    const diagrams = rawDiagrams
      .map((d: { title?: unknown; rows?: unknown; unitValue?: unknown }) => {
        if (!Array.isArray(d.rows)) return null;
        const validRows = (d.rows as RawRow[]).filter(
          r => typeof r.label === "string" && typeof r.units === "number" && r.units >= 1 && r.units <= 20
        );
        if (validRows.length === 0) return null;
        return {
          title: typeof d.title === "string" ? d.title : null,
          rows: validRows,
          unitValue: typeof d.unitValue === "string" ? d.unitValue : null,
        };
      })
      .filter(Boolean);

    const result = {
      subject: parsed.subject ?? "Math",
      topic: validTopic,
      solution: sanitizeSolverSolution(parsed.solution ?? ""),
      diagrams,
    };

    // Save before returning so a reconnecting client can pick it up.
    await prisma.solverJob.update({
      where: { id: jobId },
      data: { status: "done", result, completedAt: new Date() },
    });

    console.log("[solver] done", jobId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[solver] Gemini error:", err);
    // Normalise the user-facing error message — the raw Gemini 504
    // response is a paragraph of internal trace text ("Stream
    // cancelled / DEADLINE_EXCEEDED / prefill servable…") that
    // shouldn't show up in the mobile UI. Map known overload /
    // timeout shapes to a single friendly line.
    const rawMsg = err instanceof Error ? err.message : String(err ?? "");
    const status = (err as { status?: number } | null)?.status ?? null;
    const looksOverloaded =
      status === 504 || status === 503 || status === 429 ||
      /DEADLINE_EXCEEDED|deadline exceeded|stream cancelled|UNAVAILABLE|RESOURCE_EXHAUSTED|overload|timeout/i.test(rawMsg);
    const friendly = looksOverloaded
      ? "Solver failed due to load. Please retry."
      : "Failed to solve question";
    await prisma.solverJob
      .update({ where: { id: jobId }, data: { status: "error", error: friendly, completedAt: new Date() } })
      .catch(() => {});
    return NextResponse.json({ error: friendly }, { status: looksOverloaded ? 503 : 500 });
  }
}
