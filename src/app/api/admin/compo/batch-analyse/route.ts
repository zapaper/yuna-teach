// POST /api/admin/compo/batch-analyse
//
// Takes 2-10 already-analysed CompoAttempt IDs, pulls each attempt's
// OCR + critique + recommendations, and asks Gemini 3.1-pro to spot
// patterns that repeat across the kid's essays. Returns 3-5 advice
// buckets (Content / Language / Flow / Sentence Structure / etc.)
// each with 2-3 actionable tips and short before/after examples
// pulled from the kid's actual essays.
//
// Unlike the per-essay analyser this doesn't create a new
// CompoAttempt row — it's a one-shot read-and-summarise. The
// caller renders the result inline.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { generateContentWithRetry } from "@/lib/gemini";
import { safeJsonParse } from "@/lib/compo-analysis";

// Gemini 3.1 Pro on 5-10 capped essay blobs at 12k output tokens runs
// 30-60s in the wild — sometimes 90s when the preview backend is slow.
// Default Next.js route budget (~15s on Railway / 10s on Vercel) cuts
// the request off mid-call; the browser then sees "Failed to fetch"
// and the user has nothing to look at. Lift the cap to 5 min.
export const maxDuration = 300;

const MODEL = "gemini-3.1-pro-preview";

type BatchAdvice = {
  tip: string;
  why: string;
  examples: Array<{ from: string; before: string; after: string }>;
};
type BatchBucket = {
  title: string;
  color: "blue" | "emerald" | "amber" | "rose" | "violet" | "sky";
  advice: BatchAdvice[];
};
type BatchResult = {
  buckets: BatchBucket[];
  overview: string;
  essaysAnalysed: number;
  language: "chinese" | "english" | "mixed";
};

export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as { attemptIds?: unknown };
  const ids = Array.isArray(body.attemptIds) ? body.attemptIds.filter((x): x is string => typeof x === "string") : [];
  if (ids.length < 2) return NextResponse.json({ error: "Pick at least 2 essays" }, { status: 400 });
  if (ids.length > 10) return NextResponse.json({ error: "Maximum 10 essays per batch" }, { status: 400 });

  const attempts = await prisma.compoAttempt.findMany({
    where: { id: { in: ids }, status: "ready" },
    select: {
      id: true, label: true, studentTopic: true, language: true, englishComponent: true,
      ocrText: true, critique: true, recommendations: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (attempts.length < 2) {
    return NextResponse.json({ error: "At least 2 of the picked essays must be in 'ready' status" }, { status: 400 });
  }

  // Detect dominant language for picking the prompt voice — Chinese
  // and English get different language-of-instruction (the AI itself
  // writes in the same language so the advice can be pasted in front
  // of the student / parent directly).
  const langs = attempts.map(a => (a.language ?? "chinese").toLowerCase());
  const englishCount = langs.filter(l => l === "english").length;
  const chineseCount = langs.length - englishCount;
  const dominantLang: "chinese" | "english" | "mixed" =
    englishCount === 0 ? "chinese" :
    chineseCount === 0 ? "english" :
    "mixed";

  // Build the per-essay summary block. For each: short label, topic
  // (if any), word/char count, OCR text (capped), and the marker's
  // primary verdict so the AI sees what already-caught issues look
  // like and can build on them (not duplicate them).
  const essayBlocks = attempts.map((a, i) => {
    const ocr = (a.ocrText ?? "").trim();
    const ocrCapped = ocr.length > 2400 ? ocr.slice(0, 2400) + "\n[…truncated…]" : ocr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = a.critique as any;
    let verdict = "";
    if (c) {
      if (typeof c.component === "string") {
        // English shape
        const max = (c.primary?.max ?? 18) + (c.language?.max ?? 18);
        verdict = `Score: ${c.overallScore}/${max}. ${c.primary?.notes ?? ""} ${c.language?.notes ?? ""}`.trim();
      } else {
        // Chinese shape
        verdict = `Score: ${c.overallScore}/40. 内容: ${c.contentNotes ?? ""} 词汇: ${c.vocabNotes ?? ""} 句子: ${c.sentenceNotes ?? ""}`.trim();
      }
    }
    return `── Essay ${i + 1}: "${a.label ?? "(no label)"}"${a.studentTopic ? ` — topic: ${a.studentTopic}` : ""} (lang=${a.language ?? "chinese"})
Marker's verdict: ${verdict || "(no verdict)"}
Text:
${ocrCapped}`;
  }).join("\n\n");

  const promptHeader = dominantLang === "english"
    ? `You are a Singapore PSLE English writing coach. Below are ${attempts.length} compositions written by the SAME student across different prompts.

Look for PATTERNS that repeat across the essays — not one-off mistakes. Spot the 3-5 highest-impact areas where this student keeps falling short, and give concrete, actionable advice the student can apply immediately on their NEXT composition.`
    : dominantLang === "chinese"
    ? `你是新加坡 PSLE 华文作文老师。下面是同一位学生写的 ${attempts.length} 篇作文（不同题目）。

请找出**重复出现的模式** — 不是单次错误，而是这位学生反复犯的问题或可改进的地方。挑出 3-5 个最值得着力的方向，给出具体、可立即执行的建议，让学生下次写作时就能用上。`
    : `You are a Singapore PSLE writing coach. Below are ${attempts.length} compositions written by the same student (mixed Chinese + English). Look for patterns that repeat across both languages.`;

  const outputFmt = `【Output — strict JSON】
{
  "overview": "<1-2 sentence summary of the student's overall pattern>",
  "buckets": [
    {
      "title": "<one of: Content / Plot Development / Language / Vocabulary / Sentence Structure / Flow & Transitions / Description / Opening Hook / Climax / Resolution>",
      "color": "<one of: blue / emerald / amber / rose / violet / sky>",
      "advice": [
        {
          "tip": "<short imperative headline, 5-10 words, e.g. 'Open with a sensory hook'>",
          "why": "<1 sentence explaining the pattern you noticed across the essays>",
          "examples": [
            {
              "from": "Essay <N>",
              "before": "<short snippet from the student's actual text — verbatim>",
              "after": "<a concrete improved version of that snippet>"
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- 3-5 buckets total. Don't pad. Quality over quantity.
- **AT LEAST ONE bucket MUST cover CONTENT / PLOT / DESCRIPTION** — i.e. *what* the student is writing, not just *how* they word it. Language buckets alone are a half-coaching. Look at the climax, the build-up to it, the emotional payoff, and the resolution. If the student keeps rushing the climax, skipping the emotional reaction, or under-describing the key moment, SAY SO with a concrete fix. Examples of valid content-bucket tips:
  · "Slow down and describe the climax with the senses (sight, sound, what the character felt in their body)"
  · "Show the character's inner thoughts at the turning point — don't just narrate the action"
  · "The build-up before the climax is too short — add a quiet moment of foreboding or hope before the disaster lands"
  · "The resolution wraps up in one line — let the character reflect, change, or learn"
- 2-3 advice items per bucket maximum.
- Each advice MUST cite 1-2 examples from the student's actual essays (verbatim "before" + your "after"). For CONTENT examples the "before" can be the rushed climax line and the "after" shows the same moment expanded with description / thought / sensory detail.
- Pick a different colour per bucket so the rendered output is visually scannable.
- ${dominantLang === "english"
    ? "Write the tip / why / after fields in English."
    : dominantLang === "chinese"
    ? "建议、原因、改写都用中文。引用学生原文也保留中文。"
    : "Match the language of each example to the source essay."}
- Common-trap tips that often help PSLE students: opening hook, sensory description over plain narration, varying sentence structures, emotional dilemma in the conflict, planning the resolution before writing the climax, idiomatic phrases used in context. Pick the ones that ACTUALLY fit this student's pattern — don't list them all.

No markdown.`;

  const prompt = `${promptHeader}

${essayBlocks}

${outputFmt}`;

  console.log(`[compo:batch-analyse] calling ${MODEL} for ${attempts.length} essays (lang=${dominantLang})...`);
  const start = Date.now();
  try {
    const resp = await generateContentWithRetry({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 12000 },
    }, 2, 5000, "compo-batch-analyse");
    console.log(`[compo:batch-analyse] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = safeJsonParse((resp.text ?? "").trim(), "batch-analyse") as any;
    const validColors = new Set(["blue", "emerald", "amber", "rose", "violet", "sky"]);
    const buckets: BatchBucket[] = Array.isArray(parsed.buckets) ? parsed.buckets
      .filter((b: { title?: unknown; advice?: unknown }) => b && typeof b.title === "string" && Array.isArray(b.advice))
      .map((b: { title: string; color?: string; advice: Array<{ tip?: unknown; why?: unknown; examples?: unknown }> }, i: number) => ({
        title: String(b.title).trim(),
        color: validColors.has(String(b.color)) ? (b.color as BatchBucket["color"]) : (["blue", "emerald", "amber", "rose", "violet", "sky"] as const)[i % 6],
        advice: b.advice
          .filter(a => a && typeof a.tip === "string")
          .map(a => ({
            tip: String(a.tip).trim(),
            why: String((a as { why?: unknown }).why ?? "").trim(),
            examples: Array.isArray((a as { examples?: unknown }).examples) ? ((a as { examples: Array<{ from?: unknown; before?: unknown; after?: unknown }> }).examples)
              .filter(e => e && typeof e.before === "string" && typeof e.after === "string")
              .map(e => ({
                from: String((e as { from?: unknown }).from ?? "").trim(),
                before: String(e.before).trim(),
                after: String(e.after).trim(),
              })) : [],
          })),
      })) : [];
    const result: BatchResult = {
      buckets,
      overview: String(parsed.overview ?? "").trim(),
      essaysAnalysed: attempts.length,
      language: dominantLang,
    };
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[compo:batch-analyse] failed:`, err);
    return NextResponse.json({ error: (err as Error).message ?? "Batch analyse failed" }, { status: 500 });
  }
}
